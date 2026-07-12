/**
 * SVG export helpers for flattened developable cone patterns.
 *
 * @module PatternSVG
 * @three_import import { flattenedGeometryToSVG, downloadSVG } from 'three/addons/conics/PatternSVG.js';
 */

function flattenedGeometryToSVG( geometry ) {

	const positions = geometry.getAttribute( 'position' );
	const index = geometry.index;
	const triangleCount = index ? index.count / 3 : positions.count / 3;

	const keyPrecision = 1e6;
	const pointKey = function ( x, z ) {

		return Math.round( x * keyPrecision ) + ',' + Math.round( z * keyPrecision );

	};

	const edgeCounts = new Map();
	const pointCoords = new Map();

	const rememberPoint = function ( x, z ) {

		const key = pointKey( x, z );
		if ( ! pointCoords.has( key ) ) pointCoords.set( key, [ x, z ] );
		return key;

	};

	const addEdge = function ( ax, az, bx, bz ) {

		const aKey = rememberPoint( ax, az );
		const bKey = rememberPoint( bx, bz );
		if ( aKey === bKey ) return;

		const edgeKey = aKey < bKey ? aKey + '|' + bKey : bKey + '|' + aKey;
		edgeCounts.set( edgeKey, ( edgeCounts.get( edgeKey ) || 0 ) + 1 );

	};

	for ( let i = 0; i < triangleCount; i ++ ) {

		const i0 = index ? index.getX( i * 3 ) : i * 3;
		const i1 = index ? index.getX( i * 3 + 1 ) : i * 3 + 1;
		const i2 = index ? index.getX( i * 3 + 2 ) : i * 3 + 2;

		addEdge( positions.getX( i0 ), positions.getZ( i0 ), positions.getX( i1 ), positions.getZ( i1 ) );
		addEdge( positions.getX( i1 ), positions.getZ( i1 ), positions.getX( i2 ), positions.getZ( i2 ) );
		addEdge( positions.getX( i2 ), positions.getZ( i2 ), positions.getX( i0 ), positions.getZ( i0 ) );

	}

	// Odd parity = silhouette edge. Shared interior edges cancel to even counts;
	// clip-aligned arcs can appear more than once and must not be dropped.
	const adjacency = new Map();

	edgeCounts.forEach( function ( count, edgeKey ) {

		if ( count % 2 !== 1 ) return;

		const parts = edgeKey.split( '|' );
		const aKey = parts[ 0 ];
		const bKey = parts[ 1 ];

		if ( ! adjacency.has( aKey ) ) adjacency.set( aKey, [] );
		if ( ! adjacency.has( bKey ) ) adjacency.set( bKey, [] );

		adjacency.get( aKey ).push( bKey );
		adjacency.get( bKey ).push( aKey );

	} );

	const visitedEdges = new Set();
	const loops = [];

	const edgeId = function ( aKey, bKey ) {

		return aKey < bKey ? aKey + '|' + bKey : bKey + '|' + aKey;

	};

	adjacency.forEach( function ( neighbors, startKey ) {

		for ( let s = 0; s < neighbors.length; s ++ ) {

			const firstNeighbor = neighbors[ s ];
			const startEdge = edgeId( startKey, firstNeighbor );
			if ( visitedEdges.has( startEdge ) ) continue;

			const loop = [ pointCoords.get( startKey ) ];
			let currentKey = startKey;
			let nextKey = firstNeighbor;

			while ( nextKey ) {

				const currentEdge = edgeId( currentKey, nextKey );
				if ( visitedEdges.has( currentEdge ) ) break;
				visitedEdges.add( currentEdge );

				loop.push( pointCoords.get( nextKey ) );

				const prevKey = currentKey;
				currentKey = nextKey;
				nextKey = null;

				const currentNeighbors = adjacency.get( currentKey ) || [];
				for ( let n = 0; n < currentNeighbors.length; n ++ ) {

					if ( currentNeighbors[ n ] !== prevKey && ! visitedEdges.has( edgeId( currentKey, currentNeighbors[ n ] ) ) ) {

						nextKey = currentNeighbors[ n ];
						break;

					}

				}

				if ( currentKey === startKey ) break;

			}

			if ( loop.length >= 3 ) {

				const first = loop[ 0 ];
				const last = loop[ loop.length - 1 ];
				if ( first[ 0 ] === last[ 0 ] && first[ 1 ] === last[ 1 ] ) loop.pop();
				if ( loop.length >= 3 ) loops.push( loop );

			}

		}

	} );

	let minX = Infinity, minZ = Infinity, maxX = - Infinity, maxZ = - Infinity;

	for ( let i = 0; i < positions.count; i ++ ) {

		const x = positions.getX( i );
		const z = positions.getZ( i );
		minX = Math.min( minX, x );
		minZ = Math.min( minZ, z );
		maxX = Math.max( maxX, x );
		maxZ = Math.max( maxZ, z );

	}

	const padding = Math.max( maxX - minX, maxZ - minZ ) * 0.05 || 0.1;
	const svgScale = 100;
	const viewMinX = ( minX - padding ) * svgScale;
	const viewMinY = ( - maxZ - padding ) * svgScale;
	const viewWidth = ( ( maxX - minX ) + padding * 2 ) * svgScale;
	const viewHeight = ( ( maxZ - minZ ) + padding * 2 ) * svgScale;

	const format = function ( value ) {

		return ( value * svgScale ).toFixed( 5 );

	};

	let pathData = '';

	if ( loops.length > 0 ) {

		for ( let i = 0; i < loops.length; i ++ ) {

			const loop = loops[ i ];
			pathData += 'M ' + format( loop[ 0 ][ 0 ] ) + ' ' + format( - loop[ 0 ][ 1 ] );

			for ( let j = 1; j < loop.length; j ++ ) {

				pathData += ' L ' + format( loop[ j ][ 0 ] ) + ' ' + format( - loop[ j ][ 1 ] );

			}

			pathData += ' Z ';

		}

	} else {

		for ( let i = 0; i < triangleCount; i ++ ) {

			const i0 = index ? index.getX( i * 3 ) : i * 3;
			const i1 = index ? index.getX( i * 3 + 1 ) : i * 3 + 1;
			const i2 = index ? index.getX( i * 3 + 2 ) : i * 3 + 2;

			pathData += 'M ' + format( positions.getX( i0 ) ) + ' ' + format( - positions.getZ( i0 ) );
			pathData += ' L ' + format( positions.getX( i1 ) ) + ' ' + format( - positions.getZ( i1 ) );
			pathData += ' L ' + format( positions.getX( i2 ) ) + ' ' + format( - positions.getZ( i2 ) );
			pathData += ' Z ';

		}

	}

	return [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="' +
			viewMinX.toFixed( 5 ) + ' ' + viewMinY.toFixed( 5 ) + ' ' +
			viewWidth.toFixed( 5 ) + ' ' + viewHeight.toFixed( 5 ) + '">',
		'  <path d="' + pathData.trim() + '" fill="none" stroke="#000000" stroke-width="' +
			( Math.max( viewWidth, viewHeight ) * 0.002 ).toFixed( 5 ) + '" />',
		'</svg>'
	].join( '\n' );

}

function downloadSVG( svg, filename ) {

	const blob = new Blob( [ svg ], { type: 'image/svg+xml;charset=utf-8' } );
	const url = URL.createObjectURL( blob );
	const link = document.createElement( 'a' );
	link.href = url;
	link.download = filename;
	link.click();
	URL.revokeObjectURL( url );

}

export { flattenedGeometryToSVG, downloadSVG };
