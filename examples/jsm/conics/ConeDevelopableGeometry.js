import {
	BufferGeometry,
	Float32BufferAttribute,
	Matrix4,
	Vector3
} from 'three';
import { Earcut } from 'three/src/extras/Earcut.js';
import {
	coneSurfaceToFlatPoint,
	flatPointToConeSurface,
	extractFlatPoints,
	getConeDevelopableK,
	getFlatDevelopableOffset,
	resolveConeDevelopableParams
} from './DevelopableConeMath.js';

/**
 * Geometry helpers for developable cone flattening and lifting.
 *
 * @module ConeDevelopableGeometry
 * @three_import import * as ConeDevelopableGeometry from 'three/addons/conics/ConeDevelopableGeometry.js';
 */

function getConeLocalClippingPlanes( plane1, plane2 ) {

	// Flattening builds an unrotated cone in geometry space. The 3D cone mesh
	// has rotation.z = π relative to the clipping-group (rig) frame, where
	// plane1/plane2 are defined. Convert planes into that mesh-local frame.
	// Do not apply the rig's world pose here — pose must not affect the unroll.
	const worldToLocal = new Matrix4().makeRotationZ( Math.PI );

	return [
		plane1.clone().applyMatrix4( worldToLocal ),
		plane2.clone().applyMatrix4( worldToLocal )
	];

}

function createFlattenedGeometryFromConeBuffer( coneGeometry, params = {} ) {

	const positions = coneGeometry && coneGeometry.getAttribute( 'position' );
	const uvs = coneGeometry && coneGeometry.getAttribute( 'uv' );
	const index = coneGeometry && coneGeometry.index;
	if ( ! positions || positions.count < 3 ) return null;

	const resolved = {
		coneAngle: params.coneAngle,
		height: params.height != null ? params.height : params.coneHeight,
		radius: params.radius
	};
	const k = getConeDevelopableK( resolved.coneAngle );
	const halfHeight = resolved.height / 2;
	const count = positions.count;
	const flatPositions = new Float32Array( count * 3 );
	const flatNormals = new Float32Array( count * 3 );
	const flatUvs = new Float32Array( count * 2 );

	for ( let i = 0; i < count; i ++ ) {

		let xFlat;
		let zFlat;
		let u;
		let v;

		if ( uvs ) {

			const theta = uvs.getX( i ) * Math.PI * 2;
			v = uvs.getY( i );
			const r = v * resolved.radius;
			const R = r * k;
			const alpha = theta / k;
			xFlat = R * Math.cos( alpha );
			zFlat = R * Math.sin( alpha );
			u = uvs.getX( i );

		} else {

			const flat = coneSurfaceToFlatPoint(
				positions.getX( i ),
				positions.getY( i ),
				positions.getZ( i ),
				resolved
			);
			xFlat = flat.x;
			zFlat = flat.z;
			u = flat.theta / ( Math.PI * 2 );
			v = flat.v;

		}

		flatPositions[ i * 3 ] = xFlat;
		flatPositions[ i * 3 + 1 ] = 0;
		flatPositions[ i * 3 + 2 ] = zFlat;
		flatNormals[ i * 3 ] = 0;
		flatNormals[ i * 3 + 1 ] = 1;
		flatNormals[ i * 3 + 2 ] = 0;
		flatUvs[ i * 2 ] = u;
		flatUvs[ i * 2 + 1 ] = v;

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( flatPositions, 3 ) );
	geometry.setAttribute( 'normal', new Float32BufferAttribute( flatNormals, 3 ) );
	geometry.setAttribute( 'uv', new Float32BufferAttribute( flatUvs, 2 ) );

	if ( index ) {

		geometry.setIndex( Array.from( index.array ) );

	}

	geometry.computeBoundingBox();
	if ( geometry.boundingBox ) {

		const center = new Vector3();
		geometry.boundingBox.getCenter( center );
		geometry.translate( - center.x, 0, - center.z );
		geometry.userData.developableOffset = { x: center.x, z: center.z };

	} else {

		geometry.userData.developableOffset = { x: 0, z: 0 };

	}

	return geometry;

}

function updateLiftedConeGeometry( geometry, params = {} ) {

	const resolved = {
		coneAngle: params.coneAngle,
		height: params.height != null ? params.height : params.coneHeight,
		radius: params.radius
	};
	const positions = geometry.getAttribute( 'position' );
	const uvs = geometry.getAttribute( 'uv' );
	if ( ! positions || ! uvs ) return geometry;

	const halfHeight = resolved.height / 2;
	let minR = Infinity;
	let maxR = - Infinity;
	let outOfRangeCount = 0;

	for ( let i = 0; i < positions.count; i ++ ) {

		const theta = uvs.getX( i ) * Math.PI * 2;
		const v = uvs.getY( i );
		const r = v * resolved.radius;
		const y = halfHeight - v * resolved.height;

		positions.setXYZ( i, r * Math.cos( theta ), y, r * Math.sin( theta ) );
		minR = Math.min( minR, r );
		maxR = Math.max( maxR, r );
		if ( r > resolved.radius + 1e-6 ) outOfRangeCount ++;

	}

	positions.needsUpdate = true;
	geometry.computeVertexNormals();
	geometry.userData.developableParams = {
		coneAngle: resolved.coneAngle,
		height: resolved.height,
		radius: resolved.radius,
		inferred: {}
	};
	geometry.userData.developableRange = {
		minR: Number.isFinite( minR ) ? minR : 0,
		maxR: Number.isFinite( maxR ) ? maxR : 0,
		outOfRangeCount: outOfRangeCount
	};

	return geometry;

}

function createConeGeometryFromFlatGeometry( flatGeometry, params = {} ) {

	const srcPositions = flatGeometry && flatGeometry.getAttribute( 'position' );
	if ( ! srcPositions || srcPositions.count < 3 ) return null;

	const resolved = resolveConeDevelopableParams( flatGeometry, params );
	const offset = getFlatDevelopableOffset( flatGeometry );
	const srcUv = flatGeometry.getAttribute( 'uv' );
	const srcIndex = flatGeometry.index;
	const count = srcPositions.count;
	const halfHeight = resolved.height / 2;

	const positions = new Float32Array( count * 3 );
	const uvs = new Float32Array( count * 2 );
	let minR = Infinity;
	let maxR = - Infinity;
	let outOfRangeCount = 0;

	for ( let i = 0; i < count; i ++ ) {

		let lifted;

		if ( srcUv && ! params.useFlatPositions ) {

			// Prefer developable UVs from the forward unroll (θ/(2π), r/radius).
			// Avoids atan2 branch cuts when the flat sector spans more than π.
			const theta = srcUv.getX( i ) * Math.PI * 2;
			const v = srcUv.getY( i );
			const r = v * resolved.radius;
			const y = halfHeight - v * resolved.height;
			lifted = {
				x: r * Math.cos( theta ),
				y: y,
				z: r * Math.sin( theta ),
				r: r,
				theta: theta,
				u: srcUv.getX( i ),
				v: v
			};

		} else {

			// Exact (R, α) → (r, φ) lift for a fitted cone.
			lifted = flatPointToConeSurface(
				srcPositions.getX( i ) + offset.x,
				srcPositions.getZ( i ) + offset.z,
				resolved
			);

		}

		positions[ i * 3 ] = lifted.x;
		positions[ i * 3 + 1 ] = lifted.y;
		positions[ i * 3 + 2 ] = lifted.z;
		uvs[ i * 2 ] = lifted.u;
		uvs[ i * 2 + 1 ] = lifted.v;
		minR = Math.min( minR, lifted.r );
		maxR = Math.max( maxR, lifted.r );
		if ( lifted.r > resolved.radius + 1e-6 ) outOfRangeCount ++;

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );

	if ( srcIndex ) {

		geometry.setIndex( Array.from( srcIndex.array ) );

	}

	geometry.computeVertexNormals();
	geometry.userData.developableParams = {
		coneAngle: resolved.coneAngle,
		height: resolved.height,
		radius: resolved.radius,
		inferred: resolved.inferred
	};
	geometry.userData.developableRange = {
		minR: Number.isFinite( minR ) ? minR : 0,
		maxR: Number.isFinite( maxR ) ? maxR : 0,
		outOfRangeCount: outOfRangeCount
	};

	return geometry;

}

function normalizeFlatContour( contourPoints ) {

	const points = extractFlatPoints( contourPoints, { x: 0, z: 0 } );
	if ( points.length === 0 ) return [];

	const first = points[ 0 ];
	const last = points[ points.length - 1 ];
	if ( Math.hypot( first.x - last.x, first.z - last.z ) < 1e-9 ) {

		points.pop();

	}

	return points;

}

function createConeGeometryFromFlatContour( contourPoints, params = {} ) {

	const contour = normalizeFlatContour( contourPoints );
	if ( contour.length < 3 ) return null;

	const flatData = [];
	for ( let i = 0; i < contour.length; i ++ ) {

		flatData.push( contour[ i ].x, contour[ i ].z );

	}

	const triangles = Earcut.triangulate( flatData, null, 2 );
	const positions = [];
	for ( let i = 0; i < contour.length; i ++ ) {

		positions.push( contour[ i ].x, 0, contour[ i ].z );

	}

	const flatGeometry = new BufferGeometry();
	flatGeometry.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
	flatGeometry.setIndex( triangles );
	flatGeometry.userData.developableOffset = { x: 0, z: 0 };

	return createConeGeometryFromFlatGeometry( flatGeometry, params );

}

function createConeGeometryFromPattern( input, params = {} ) {

	if ( input && input.isBufferGeometry ) {

		return createConeGeometryFromFlatGeometry( input, params );

	}

	return createConeGeometryFromFlatContour( input, params );

}

function createFlattenedConeGeometry( radius, height, radialSegments, coneAngle, plane1, plane2, applyCuts = true ) {

	const positions = [];
	const normals = [];
	const uvs = [];
	const indices = [];

	const heightSegments = 20;
	const halfHeight = height / 2;
	const k = getConeDevelopableK( coneAngle );

	if ( applyCuts ) {

		const localPlanes = getConeLocalClippingPlanes( plane1, plane2 );
		plane1 = localPlanes[ 0 ];
		plane2 = localPlanes[ 1 ];

	}

	const vertices = [];
	for ( let iy = 0; iy <= heightSegments; iy ++ ) {

		const y = halfHeight - ( iy / heightSegments ) * height;
		const r = radius * ( iy / heightSegments );

		for ( let ix = 0; ix <= radialSegments; ix ++ ) {

			const theta = ix / radialSegments * Math.PI * 2;
			const x = r * Math.cos( theta );
			const z = r * Math.sin( theta );
			const position = new Vector3( x, y, z );
			vertices.push( { position: position, theta: theta, r: r } );

		}

	}

	const clipPolygon = function ( polygon, plane ) {

		const output = [];
		const count = polygon.length;

		for ( let i = 0; i < count; i ++ ) {

			const a = polygon[ i ];
			const b = polygon[ ( i + 1 ) % count ];
			const da = plane.distanceToPoint( a.position );
			const db = plane.distanceToPoint( b.position );
			const aInside = da >= 0;
			const bInside = db >= 0;

			if ( aInside ) output.push( a );
			if ( aInside !== bInside ) {

				const t = da / ( da - db );
				const interpPosition = a.position.clone().lerp( b.position, t );
				const interpTheta = a.theta + ( b.theta - a.theta ) * t;
				const interpR = a.r + ( b.r - a.r ) * t;
				output.push( { position: interpPosition, theta: interpTheta, r: interpR } );

			}

		}

		return output;

	};

	for ( let iy = 0; iy < heightSegments; iy ++ ) {

		for ( let ix = 0; ix < radialSegments; ix ++ ) {

			const baseIndex = iy * ( radialSegments + 1 ) + ix;
			const quad = [
				vertices[ baseIndex ],
				vertices[ baseIndex + 1 ],
				vertices[ baseIndex + radialSegments + 2 ],
				vertices[ baseIndex + radialSegments + 1 ]
			];

			let clipped = quad;
			if ( applyCuts ) {

				clipped = clipPolygon( clipPolygon( quad, plane1 ), plane2 );

			}

			if ( clipped.length < 3 ) continue;

			for ( let j = 1; j < clipped.length - 1; j ++ ) {

				const a = clipped[ 0 ];
				const b = clipped[ j ];
				const c = clipped[ j + 1 ];
				const base = positions.length / 3;

				[ a, b, c ].forEach( function ( vert ) {

					const R = vert.r * k;
					const theta = vert.theta / k;
					const xNet = R * Math.cos( theta );
					const zNet = R * Math.sin( theta );
					positions.push( xNet, 0, zNet );
					normals.push( 0, 1, 0 );
					uvs.push( ( vert.theta / ( Math.PI * 2 ) ), ( halfHeight - vert.position.y ) / height );

				} );

				indices.push( base, base + 1, base + 2 );

			}

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
	geometry.setAttribute( 'uv', new Float32BufferAttribute( uvs, 2 ) );
	geometry.setIndex( indices );

	geometry.computeBoundingBox();
	if ( geometry.boundingBox ) {

		const center = new Vector3();
		geometry.boundingBox.getCenter( center );
		geometry.translate( - center.x, 0, - center.z );
		// Apex-centric origin before centering; inverse lift must undo this shift.
		geometry.userData.developableOffset = { x: center.x, z: center.z };

	} else {

		geometry.userData.developableOffset = { x: 0, z: 0 };

	}

	return geometry;

}

function createClippedConeGeometry( radius, height, radialSegments, plane1, plane2 ) {

	const positions = [];
	const normals = [];
	const indices = [];

	const heightSegments = 20;
	const halfHeight = height / 2;
	const localPlanes = getConeLocalClippingPlanes( plane1, plane2 );
	plane1 = localPlanes[ 0 ];
	plane2 = localPlanes[ 1 ];

	const vertices = [];
	for ( let iy = 0; iy <= heightSegments; iy ++ ) {

		const y = halfHeight - ( iy / heightSegments ) * height;
		const r = radius * ( iy / heightSegments );

		for ( let ix = 0; ix <= radialSegments; ix ++ ) {

			const theta = ix / radialSegments * Math.PI * 2;
			const x = r * Math.cos( theta );
			const z = r * Math.sin( theta );
			vertices.push( { position: new Vector3( x, y, z ) } );

		}

	}

	const clipPolygon = function ( polygon, plane ) {

		const output = [];
		const count = polygon.length;

		for ( let i = 0; i < count; i ++ ) {

			const a = polygon[ i ];
			const b = polygon[ ( i + 1 ) % count ];
			const da = plane.distanceToPoint( a.position );
			const db = plane.distanceToPoint( b.position );
			const aInside = da >= 0;
			const bInside = db >= 0;

			if ( aInside ) output.push( a );
			if ( aInside !== bInside ) {

				const t = da / ( da - db );
				const interpPosition = a.position.clone().lerp( b.position, t );
				output.push( { position: interpPosition } );

			}

		}

		return output;

	};

	for ( let iy = 0; iy < heightSegments; iy ++ ) {

		for ( let ix = 0; ix < radialSegments; ix ++ ) {

			const baseIndex = iy * ( radialSegments + 1 ) + ix;
			const quad = [
				vertices[ baseIndex ],
				vertices[ baseIndex + 1 ],
				vertices[ baseIndex + radialSegments + 2 ],
				vertices[ baseIndex + radialSegments + 1 ]
			];

			let clipped = clipPolygon( quad, plane1 );
			clipped = clipPolygon( clipped, plane2 );

			if ( clipped.length < 3 ) continue;

			for ( let j = 1; j < clipped.length - 1; j ++ ) {

				const a = clipped[ 0 ];
				const b = clipped[ j ];
				const c = clipped[ j + 1 ];
				const base = positions.length / 3;

				const vA = a.position;
				const vB = b.position;
				const vC = c.position;
				const normal = new Vector3().subVectors( vB, vA ).cross( new Vector3().subVectors( vC, vA ) ).normalize();

				[ a, b, c ].forEach( function ( vert ) {

					positions.push( vert.position.x, vert.position.y, vert.position.z );
					normals.push( normal.x, normal.y, normal.z );

				} );

				indices.push( base, base + 1, base + 2 );

			}

		}

	}

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( positions, 3 ) );
	geometry.setAttribute( 'normal', new Float32BufferAttribute( normals, 3 ) );
	geometry.setIndex( indices );

	return geometry;

}

export {
	getConeLocalClippingPlanes,
	createFlattenedGeometryFromConeBuffer,
	updateLiftedConeGeometry,
	createConeGeometryFromFlatGeometry,
	normalizeFlatContour,
	createConeGeometryFromFlatContour,
	createConeGeometryFromPattern,
	createFlattenedConeGeometry,
	createClippedConeGeometry
};
