/**
 * Developable cone math: flat net ↔ cone surface mappings and parameter fitting.
 *
 * @module DevelopableConeMath
 * @three_import import * as DevelopableConeMath from 'three/addons/conics/DevelopableConeMath.js';
 */

const APEX_EPS = 1e-10;

function getConeDevelopableK( coneAngle ) {

	return 1 / Math.sin( coneAngle );

}

function getFlatDevelopableOffset( flatGeometry ) {

	const offset = flatGeometry && flatGeometry.userData && flatGeometry.userData.developableOffset;
	if ( offset ) return { x: offset.x || 0, z: offset.z || 0 };
	return { x: 0, z: 0 };

}

function flatPointToConeSurface( xFlat, zFlat, params ) {

	const { coneAngle, height, radius } = params;
	const k = getConeDevelopableK( coneAngle );
	const halfHeight = height / 2;
	const R = Math.hypot( xFlat, zFlat );

	if ( R < APEX_EPS ) {

		return {
			x: 0,
			y: halfHeight,
			z: 0,
			r: 0,
			theta: 0,
			u: 0,
			v: 0
		};

	}

	const alpha = Math.atan2( zFlat, xFlat );
	const r = R / k;
	const theta = alpha * k;
	const y = halfHeight - ( r / radius ) * height;

	return {
		x: r * Math.cos( theta ),
		y: y,
		z: r * Math.sin( theta ),
		r: r,
		theta: theta,
		u: theta / ( Math.PI * 2 ),
		v: ( halfHeight - y ) / height
	};

}

function coneSurfaceToFlatPoint( x, y, z, params ) {

	const { coneAngle, height, radius } = params;
	const k = getConeDevelopableK( coneAngle );
	const halfHeight = height / 2;
	const r = Math.hypot( x, z );
	let theta = r < APEX_EPS ? 0 : Math.atan2( z, x );
	// Match the forward sampler's θ ∈ [0, 2π) so α = θ/k round-trips.
	if ( theta < 0 ) theta += Math.PI * 2;
	const R = r * k;
	const alpha = theta / k;

	return {
		x: R * Math.cos( alpha ),
		z: R * Math.sin( alpha ),
		r: r,
		theta: theta,
		v: radius > 0 ? ( r / radius ) : ( ( halfHeight - y ) / height )
	};

}

function extractFlatPoints( input, offset ) {

	const points = [];
	const ox = offset ? offset.x : 0;
	const oz = offset ? offset.z : 0;

	if ( ! input ) return points;

	if ( input.isBufferGeometry ) {

		const positions = input.getAttribute( 'position' );
		if ( ! positions ) return points;

		for ( let i = 0; i < positions.count; i ++ ) {

			points.push( {
				x: positions.getX( i ) + ox,
				z: positions.getZ( i ) + oz
			} );

		}

		return points;

	}

	if ( Array.isArray( input ) ) {

		for ( let i = 0; i < input.length; i ++ ) {

			const p = input[ i ];
			if ( Array.isArray( p ) ) {

				points.push( { x: p[ 0 ] + ox, z: p[ 1 ] + oz } );

			} else if ( p && typeof p.x === 'number' ) {

				// Vector2 uses y for the second planar axis; Vector3 uses z
				const z = typeof p.z === 'number' ? p.z : p.y;
				points.push( { x: p.x + ox, z: z + oz } );

			}

		}

	}

	return points;

}

function angularSpan( points ) {

	const angles = [];
	for ( let i = 0; i < points.length; i ++ ) {

		const R = Math.hypot( points[ i ].x, points[ i ].z );
		if ( R < APEX_EPS ) continue;
		angles.push( Math.atan2( points[ i ].z, points[ i ].x ) );

	}

	if ( angles.length < 2 ) return 0;

	angles.sort( function ( a, b ) {

		return a - b;

	} );

	let maxGap = 0;
	for ( let i = 0; i < angles.length - 1; i ++ ) {

		maxGap = Math.max( maxGap, angles[ i + 1 ] - angles[ i ] );

	}

	maxGap = Math.max( maxGap, ( angles[ 0 ] + Math.PI * 2 ) - angles[ angles.length - 1 ] );
	const span = Math.PI * 2 - maxGap;
	return span > 0 ? span : 0;

}

function inferConeAngleFromFlatPoints( points ) {

	const phi = angularSpan( points );
	const ratio = Math.min( Math.max( phi / ( Math.PI * 2 ), 1e-6 ), 1 - 1e-6 );
	return Math.asin( ratio );

}

function inferRadiusFromFlatPoints( points, coneAngle ) {

	const k = getConeDevelopableK( coneAngle );
	let maxR = 0;
	for ( let i = 0; i < points.length; i ++ ) {

		maxR = Math.max( maxR, Math.hypot( points[ i ].x, points[ i ].z ) );

	}

	return maxR / k;

}

// Unique right circular cone fitting a flat developable net:
// flat polar (R, α) ↔ cone (r, φ) via k = 1/sin(α_cone), r = R/k, φ = α*k.
// Sector angle φ_flat = 2π sin(α_cone) when the net covers a full 2π of generators.
function fitConeFromFlatGeometry( flatGeometry ) {

	const offset = getFlatDevelopableOffset( flatGeometry );
	const points = extractFlatPoints( flatGeometry, offset );
	const sectorAngle = angularSpan( points );
	const coneAngle = inferConeAngleFromFlatPoints( points );
	const k = getConeDevelopableK( coneAngle );
	let minR = Infinity;
	let maxR = 0;

	for ( let i = 0; i < points.length; i ++ ) {

		const R = Math.hypot( points[ i ].x, points[ i ].z );
		minR = Math.min( minR, R );
		maxR = Math.max( maxR, R );

	}

	if ( ! Number.isFinite( minR ) ) minR = 0;
	if ( ! Number.isFinite( maxR ) ) maxR = 0;

	const radius = maxR / k;
	const height = coneAngle > 1e-6 ? radius / Math.tan( coneAngle ) : 5;

	return {
		coneAngle: coneAngle,
		radius: radius,
		height: height,
		k: k,
		sectorAngle: sectorAngle,
		minR: minR,
		maxR: maxR,
		minRCone: minR / k,
		maxRCone: radius
	};

}

function resolveConeDevelopableParams( flatInput, params = {} ) {

	const offset = flatInput && flatInput.isBufferGeometry
		? getFlatDevelopableOffset( flatInput )
		: { x: 0, z: 0 };
	const points = extractFlatPoints( flatInput, offset );
	const inferred = {};

	if ( params.fitFromFlat ) {

		const fitted = flatInput && flatInput.isBufferGeometry
			? fitConeFromFlatGeometry( flatInput )
			: {
				coneAngle: inferConeAngleFromFlatPoints( points ),
				radius: null,
				height: null
			};
		if ( fitted.radius == null ) {

			fitted.radius = inferRadiusFromFlatPoints( points, fitted.coneAngle );
			fitted.height = fitted.coneAngle > 1e-6 ? fitted.radius / Math.tan( fitted.coneAngle ) : 5;

		}

		return {
			coneAngle: fitted.coneAngle,
			height: fitted.height,
			radius: fitted.radius,
			inferred: { coneAngle: true, height: true, radius: true }
		};

	}

	let height = params.height != null ? params.height : params.coneHeight;
	if ( height == null ) {

		height = 5;
		inferred.height = true;

	}

	let coneAngle = params.coneAngle;
	if ( coneAngle == null ) {

		coneAngle = inferConeAngleFromFlatPoints( points );
		inferred.coneAngle = true;

	}

	let radius = params.radius;
	if ( radius == null ) {

		radius = inferRadiusFromFlatPoints( points, coneAngle );
		inferred.radius = true;

	}

	if ( inferred.coneAngle && inferred.radius && inferred.height ) {

		height = coneAngle > 1e-6 ? radius / Math.tan( coneAngle ) : height;

	}

	return { coneAngle: coneAngle, height: height, radius: radius, inferred: inferred };

}

function measureFlatConeRoundTrip( flatGeometry, params = {} ) {

	if ( ! flatGeometry || ! flatGeometry.getAttribute( 'position' ) ) return null;

	const resolved = resolveConeDevelopableParams( flatGeometry, params );
	const offset = getFlatDevelopableOffset( flatGeometry );
	const k = getConeDevelopableK( resolved.coneAngle );
	const seamShift = ( Math.PI * 2 ) / k;
	const halfHeight = resolved.height / 2;
	const srcPositions = flatGeometry.getAttribute( 'position' );
	const srcUv = flatGeometry.getAttribute( 'uv' );
	let maxError = 0;
	let minR = Infinity;
	let maxR = - Infinity;
	let outOfRangeCount = 0;

	for ( let i = 0; i < srcPositions.count; i ++ ) {

		const xFlat = srcPositions.getX( i ) + offset.x;
		const zFlat = srcPositions.getZ( i ) + offset.z;
		let lifted;

		if ( srcUv && ! params.useFlatPositions ) {

			const theta = srcUv.getX( i ) * Math.PI * 2;
			const v = srcUv.getY( i );
			const r = v * resolved.radius;
			lifted = {
				x: r * Math.cos( theta ),
				y: halfHeight - v * resolved.height,
				z: r * Math.sin( theta ),
				r: r
			};

		} else {

			lifted = flatPointToConeSurface( xFlat, zFlat, resolved );

		}

		const back = coneSurfaceToFlatPoint( lifted.x, lifted.y, lifted.z, resolved );

		// Seam vertices (θ=0 and θ=2π) share a 3D point but differ in flat α by 2π/k.
		let err = Math.hypot( back.x - xFlat, back.z - zFlat );
		const Rb = Math.hypot( back.x, back.z );
		if ( Rb >= APEX_EPS ) {

			const ab = Math.atan2( back.z, back.x );
			for ( let s = - 1; s <= 1; s += 2 ) {

				const xs = Rb * Math.cos( ab + s * seamShift );
				const zs = Rb * Math.sin( ab + s * seamShift );
				err = Math.min( err, Math.hypot( xs - xFlat, zs - zFlat ) );

			}

		}

		maxError = Math.max( maxError, err );
		minR = Math.min( minR, lifted.r );
		maxR = Math.max( maxR, lifted.r );
		if ( lifted.r > resolved.radius + 1e-6 ) outOfRangeCount ++;

	}

	return {
		maxError: maxError,
		minR: Number.isFinite( minR ) ? minR : 0,
		maxR: Number.isFinite( maxR ) ? maxR : 0,
		outOfRangeCount: outOfRangeCount,
		params: resolved
	};

}

export {
	APEX_EPS,
	getConeDevelopableK,
	getFlatDevelopableOffset,
	flatPointToConeSurface,
	coneSurfaceToFlatPoint,
	extractFlatPoints,
	angularSpan,
	inferConeAngleFromFlatPoints,
	inferRadiusFromFlatPoints,
	fitConeFromFlatGeometry,
	resolveConeDevelopableParams,
	measureFlatConeRoundTrip
};
