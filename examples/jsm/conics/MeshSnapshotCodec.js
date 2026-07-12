/**
 * Codec for BufferGeometry ↔ serializable mesh records (typed arrays / legacy base64).
 *
 * @module MeshSnapshotCodec
 * @three_import import { serializeBufferGeometry, deserializeBufferGeometry } from 'three/addons/conics/MeshSnapshotCodec.js';
 */

import { BufferGeometry, Float32BufferAttribute } from 'three';

function mixHashBytes( hash, bytes ) {

	let h = hash;
	for ( let i = 0; i < bytes.length; i ++ ) {

		h ^= bytes[ i ];
		h = Math.imul( h, 16777619 );

	}

	return h;

}

function mixHashTypedArray( hash, typedArray ) {

	if ( ! typedArray ) return hash;
	return mixHashBytes( hash, new Uint8Array( typedArray.buffer, typedArray.byteOffset, typedArray.byteLength ) );

}

function hashMeshRecord( record ) {

	let h = 2166136261 >>> 0;
	h = mixHashTypedArray( h, record.position );
	h = mixHashTypedArray( h, record.uv );

	if ( record.index && record.index.data ) {

		h ^= record.index.type === 'u16' ? 1 : 2;
		h = mixHashTypedArray( h, record.index.data );

	}

	if ( record.developableOffset ) {

		const offset = new Float32Array( [
			record.developableOffset.x || 0,
			record.developableOffset.z || 0
		] );
		h = mixHashTypedArray( h, offset );

	}

	return 'm' + ( h >>> 0 ).toString( 16 );

}

function copyFloat32Attr( attribute ) {

	if ( ! attribute ) return null;
	return attribute.array instanceof Float32Array
		? new Float32Array( attribute.array )
		: new Float32Array( attribute.array );

}

function copyIndexAttr( index ) {

	if ( ! index ) return null;

	const src = index.array;
	let max = 0;
	for ( let i = 0; i < src.length; i ++ ) max = Math.max( max, src[ i ] );

	if ( max <= 65535 ) {

		return {
			type: 'u16',
			data: src instanceof Uint16Array ? new Uint16Array( src ) : new Uint16Array( src )
		};

	}

	return {
		type: 'u32',
		data: src instanceof Uint32Array ? new Uint32Array( src ) : new Uint32Array( src )
	};

}

function typedArrayToBase64( typedArray ) {

	const bytes = new Uint8Array( typedArray.buffer, typedArray.byteOffset, typedArray.byteLength );
	const chunk = 0x8000;
	let binary = '';

	for ( let i = 0; i < bytes.length; i += chunk ) {

		binary += String.fromCharCode.apply( null, bytes.subarray( i, i + chunk ) );

	}

	return btoa( binary );

}

function base64ToTypedArray( base64, TypedArray ) {

	const binary = atob( base64 );
	const bytes = new Uint8Array( binary.length );

	for ( let i = 0; i < binary.length; i ++ ) {

		bytes[ i ] = binary.charCodeAt( i );

	}

	return new TypedArray( bytes.buffer );

}

function decodeFloat32Attr( data ) {

	if ( ! data ) return null;
	if ( data instanceof Float32Array ) return data;
	if ( ArrayBuffer.isView( data ) ) return new Float32Array( data.buffer, data.byteOffset, data.byteLength / 4 );
	if ( typeof data === 'string' ) return base64ToTypedArray( data, Float32Array );
	if ( Array.isArray( data ) ) return new Float32Array( data );
	return null;

}

function decodeIndexAttr( data ) {

	if ( ! data ) return null;

	if ( typeof data === 'object' && data.data != null && data.type ) {

		if ( ArrayBuffer.isView( data.data ) ) return Array.from( data.data );
		if ( typeof data.data === 'string' ) {

			const TypedArray = data.type === 'u16' ? Uint16Array : Uint32Array;
			return Array.from( base64ToTypedArray( data.data, TypedArray ) );

		}

		if ( Array.isArray( data.data ) ) return data.data;

	}

	if ( typeof data === 'string' ) return Array.from( base64ToTypedArray( data, Uint32Array ) );
	if ( Array.isArray( data ) ) return data;
	if ( ArrayBuffer.isView( data ) ) return Array.from( data );
	return null;

}

function serializeBufferGeometry( geometry ) {

	if ( ! geometry || ! geometry.isBufferGeometry ) return null;

	const position = copyFloat32Attr( geometry.getAttribute( 'position' ) );
	if ( ! position || position.length < 9 ) return null;

	const snapshot = {
		encoding: 'typed',
		position: position
	};

	const uv = copyFloat32Attr( geometry.getAttribute( 'uv' ) );
	if ( uv ) snapshot.uv = uv;

	const index = copyIndexAttr( geometry.index );
	if ( index ) snapshot.index = index;

	if ( geometry.userData && geometry.userData.developableParams ) {

		snapshot.developableParams = {
			coneAngle: geometry.userData.developableParams.coneAngle,
			height: geometry.userData.developableParams.height,
			radius: geometry.userData.developableParams.radius
		};

	}

	if ( geometry.userData && geometry.userData.developableRange ) {

		snapshot.developableRange = {
			minR: geometry.userData.developableRange.minR,
			maxR: geometry.userData.developableRange.maxR,
			outOfRangeCount: geometry.userData.developableRange.outOfRangeCount
		};

	}

	if ( geometry.userData && geometry.userData.developableOffset ) {

		snapshot.developableOffset = {
			x: geometry.userData.developableOffset.x,
			z: geometry.userData.developableOffset.z
		};

	}

	return snapshot;

}

function migrateLegacyMeshSnapshot( snapshot ) {

	if ( ! snapshot ) return null;
	if ( snapshot.encoding === 'typed' && snapshot.position instanceof Float32Array ) return snapshot;

	const positions = decodeFloat32Attr( snapshot.position );
	if ( ! positions || positions.length < 9 ) return null;

	const record = {
		encoding: 'typed',
		position: positions
	};

	const uvs = decodeFloat32Attr( snapshot.uv );
	if ( uvs ) record.uv = uvs;

	if ( snapshot.index ) {

		if ( typeof snapshot.index === 'object' && snapshot.index.data != null && ArrayBuffer.isView( snapshot.index.data ) ) {

			record.index = {
				type: snapshot.index.type === 'u16' ? 'u16' : 'u32',
				data: snapshot.index.type === 'u16'
					? new Uint16Array( snapshot.index.data )
					: new Uint32Array( snapshot.index.data )
			};

		} else {

			const indices = decodeIndexAttr( snapshot.index );
			if ( indices && indices.length >= 3 ) {

				let max = 0;
				for ( let i = 0; i < indices.length; i ++ ) max = Math.max( max, indices[ i ] );
				record.index = max <= 65535
					? { type: 'u16', data: new Uint16Array( indices ) }
					: { type: 'u32', data: new Uint32Array( indices ) };

			}

		}

	}

	if ( snapshot.developableParams ) record.developableParams = snapshot.developableParams;
	if ( snapshot.developableRange ) record.developableRange = snapshot.developableRange;
	if ( snapshot.developableOffset ) record.developableOffset = snapshot.developableOffset;

	return record;

}

function deserializeBufferGeometry( snapshot ) {

	if ( ! snapshot ) return null;

	const record = migrateLegacyMeshSnapshot( snapshot );
	if ( ! record ) return null;

	const positions = record.position;
	if ( ! positions || positions.length < 9 ) return null;

	const geometry = new BufferGeometry();
	geometry.setAttribute( 'position', new Float32BufferAttribute( new Float32Array( positions ), 3 ) );

	if ( record.uv && record.uv.length >= 2 ) {

		geometry.setAttribute( 'uv', new Float32BufferAttribute( new Float32Array( record.uv ), 2 ) );

	}

	const legacyNormals = decodeFloat32Attr( snapshot.normal );
	if ( legacyNormals && legacyNormals.length >= 3 ) {

		geometry.setAttribute( 'normal', new Float32BufferAttribute( legacyNormals, 3 ) );

	}

	if ( record.index && record.index.data ) {

		geometry.setIndex( Array.from( record.index.data ) );

	}

	if ( record.developableParams ) {

		geometry.userData.developableParams = {
			coneAngle: record.developableParams.coneAngle,
			height: record.developableParams.height,
			radius: record.developableParams.radius,
			inferred: {}
		};

	}

	if ( record.developableRange ) {

		geometry.userData.developableRange = {
			minR: record.developableRange.minR,
			maxR: record.developableRange.maxR,
			outOfRangeCount: record.developableRange.outOfRangeCount
		};

	}

	if ( record.developableOffset ) {

		geometry.userData.developableOffset = {
			x: record.developableOffset.x,
			z: record.developableOffset.z
		};

	}

	if ( ! geometry.getAttribute( 'normal' ) ) {

		geometry.computeVertexNormals();

	}

	return geometry;

}

export {
	serializeBufferGeometry,
	deserializeBufferGeometry,
	hashMeshRecord,
	migrateLegacyMeshSnapshot
};
