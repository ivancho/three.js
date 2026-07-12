/**
 * IndexedDB mesh blob store with redo-disposal tracking and unreferenced GC.
 *
 * @module MeshIndexedDB
 * @three_import import { MeshIndexedDB } from 'three/addons/conics/MeshIndexedDB.js';
 */

import {
	deserializeBufferGeometry,
	hashMeshRecord,
	migrateLegacyMeshSnapshot
} from './MeshSnapshotCodec.js';

function stripInlineMeshes( params ) {

	if ( ! params ) return params;

	const next = Object.assign( {}, params );
	delete next.coneMesh;
	delete next.patternMesh;
	return next;

}

class MeshIndexedDB {

	constructor( {
		dbName = 'threejs.webgpu_multiple_elements.meshes',
		dbVersion = 2,
		meshStoreName = 'meshes',
		redoDisposalStore = 'redoDisposal',
		redoDisposalLimit = 30
	} = {} ) {

		this.dbName = dbName;
		this.dbVersion = dbVersion;
		this.meshStoreName = meshStoreName;
		this.redoDisposalStore = redoDisposalStore;
		this.redoDisposalLimit = redoDisposalLimit;

		this._dbPromise = null;
		this.meshMemoryCache = new Map();
		this.pendingMeshWrites = new Map();
		this.redoDisposalCache = new Map();

	}

	openMeshDb() {

		if ( this._dbPromise ) return this._dbPromise;

		const self = this;

		this._dbPromise = new Promise( function ( resolve, reject ) {

			const request = indexedDB.open( self.dbName, self.dbVersion );

			request.onupgradeneeded = function () {

				const db = request.result;
				if ( ! db.objectStoreNames.contains( self.meshStoreName ) ) {

					db.createObjectStore( self.meshStoreName, { keyPath: 'id' } );

				}

				if ( ! db.objectStoreNames.contains( self.redoDisposalStore ) ) {

					db.createObjectStore( self.redoDisposalStore, { keyPath: 'peelTimestamp' } );

				}

			};

			request.onsuccess = function () {

				resolve( request.result );

			};

			request.onerror = function () {

				self._dbPromise = null;
				reject( request.error || new Error( 'Failed to open mesh IndexedDB' ) );

			};

		} );

		return this._dbPromise;

	}

	async ensureRedoDisposalStore( db ) {

		if ( db.objectStoreNames.contains( this.redoDisposalStore ) ) return db;

		db.close();
		this._dbPromise = null;
		return this.openMeshDb();

	}

	snapshotForDisposal( entry ) {

		if ( ! entry ) return null;
		return {
			t: entry.t,
			params: stripInlineMeshes( entry.params )
		};

	}

	async putRedoDisposal( record ) {

		this.redoDisposalCache.set( record.peelTimestamp, record );

		try {

			let db = await this.openMeshDb();
			db = await this.ensureRedoDisposalStore( db );
			const storeName = this.redoDisposalStore;

			await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readwrite' );
				tx.objectStore( storeName ).put( record );
				tx.oncomplete = function () {

					resolve();

				};

				tx.onerror = function () {

					reject( tx.error );

				};

			} );

			await this.pruneRedoDisposal();

		} catch ( e ) {

			console.warn( 'Failed to store redo disposal', e );

		}

	}

	async getRedoDisposal( peelTimestamp ) {

		if ( peelTimestamp == null ) return null;
		if ( this.redoDisposalCache.has( peelTimestamp ) ) return this.redoDisposalCache.get( peelTimestamp );

		try {

			let db = await this.openMeshDb();
			db = await this.ensureRedoDisposalStore( db );
			const storeName = this.redoDisposalStore;

			const record = await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readonly' );
				const request = tx.objectStore( storeName ).get( peelTimestamp );
				request.onsuccess = function () {

					resolve( request.result || null );

				};

				request.onerror = function () {

					reject( request.error );

				};

			} );

			if ( record ) this.redoDisposalCache.set( peelTimestamp, record );
			return record;

		} catch ( e ) {

			console.warn( 'Failed to load redo disposal', e );
			return null;

		}

	}

	async deleteRedoDisposal( peelTimestamp ) {

		if ( peelTimestamp == null ) return;
		this.redoDisposalCache.delete( peelTimestamp );

		try {

			const db = await this.openMeshDb();
			if ( ! db.objectStoreNames.contains( this.redoDisposalStore ) ) return;

			const storeName = this.redoDisposalStore;

			await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readwrite' );
				tx.objectStore( storeName ).delete( peelTimestamp );
				tx.oncomplete = function () {

					resolve();

				};

				tx.onerror = function () {

					reject( tx.error );

				};

			} );

		} catch ( e ) {

			console.warn( 'Failed to delete redo disposal', e );

		}

	}

	async clearRedoDisposal() {

		this.redoDisposalCache.clear();

		try {

			const db = await this.openMeshDb();
			if ( ! db.objectStoreNames.contains( this.redoDisposalStore ) ) return;

			const storeName = this.redoDisposalStore;

			await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readwrite' );
				tx.objectStore( storeName ).clear();
				tx.oncomplete = function () {

					resolve();

				};

				tx.onerror = function () {

					reject( tx.error );

				};

			} );

		} catch ( e ) {

			console.warn( 'Failed to clear redo disposal', e );

		}

	}

	async pruneRedoDisposal() {

		if ( this.redoDisposalCache.size <= this.redoDisposalLimit ) return;

		const keys = Array.from( this.redoDisposalCache.keys() ).sort( function ( a, b ) {

			return b - a;

		} );

		for ( let i = this.redoDisposalLimit; i < keys.length; i ++ ) {

			await this.deleteRedoDisposal( keys[ i ] );

		}

	}

	async loadRedoDisposalCache() {

		try {

			let db = await this.openMeshDb();
			db = await this.ensureRedoDisposalStore( db );
			const storeName = this.redoDisposalStore;

			const records = await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readonly' );
				const request = tx.objectStore( storeName ).getAll();
				request.onsuccess = function () {

					resolve( request.result || [] );

				};

				request.onerror = function () {

					reject( request.error );

				};

			} );

			this.redoDisposalCache.clear();
			for ( let i = 0; i < records.length; i ++ ) {

				this.redoDisposalCache.set( records[ i ].peelTimestamp, records[ i ] );

			}

		} catch ( e ) {

			console.warn( 'Failed to load redo disposal cache', e );

		}

	}

	queueMeshRecord( id, record ) {

		const entry = Object.assign( { id: id }, record );
		this.meshMemoryCache.set( id, entry );
		this.pendingMeshWrites.set( id, entry );

	}

	async flushMeshWrites() {

		if ( this.pendingMeshWrites.size === 0 ) return;

		const entries = Array.from( this.pendingMeshWrites.values() );
		this.pendingMeshWrites.clear();

		try {

			const db = await this.openMeshDb();
			const storeName = this.meshStoreName;

			await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readwrite' );
				const objectStore = tx.objectStore( storeName );

				for ( let i = 0; i < entries.length; i ++ ) {

					objectStore.put( entries[ i ] );

				}

				tx.oncomplete = function () {

					resolve();

				};

				tx.onerror = function () {

					reject( tx.error );

				};

				tx.onabort = function () {

					reject( tx.error || new Error( 'Mesh IndexedDB write aborted' ) );

				};

			} );

		} catch ( e ) {

			for ( let i = 0; i < entries.length; i ++ ) {

				this.pendingMeshWrites.set( entries[ i ].id, entries[ i ] );

			}

			console.warn( 'Failed to persist meshes to IndexedDB', e );
			throw e;

		}

	}

	async getMeshRecord( id ) {

		if ( ! id ) return null;
		if ( this.meshMemoryCache.has( id ) ) return this.meshMemoryCache.get( id );

		try {

			const db = await this.openMeshDb();
			const storeName = this.meshStoreName;

			const record = await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readonly' );
				const request = tx.objectStore( storeName ).get( id );
				request.onsuccess = function () {

					resolve( request.result || null );

				};

				request.onerror = function () {

					reject( request.error );

				};

			} );

			if ( record ) this.meshMemoryCache.set( id, record );
			return record;

		} catch ( e ) {

			console.warn( 'Failed to load mesh from IndexedDB', id, e );
			return null;

		}

	}

	collectReferencedMeshIds( store ) {

		const ids = new Set();

		function addFromParams( params ) {

			if ( ! params ) return;
			if ( params.coneMeshId ) ids.add( params.coneMeshId );
			if ( params.patternMeshId ) ids.add( params.patternMeshId );

		}

		function walk( list ) {

			if ( ! Array.isArray( list ) ) return;
			for ( let i = 0; i < list.length; i ++ ) {

				if ( list[ i ] ) addFromParams( list[ i ].params );

			}

		}

		if ( store ) {

			walk( store.autosave );
			walk( store.pending );

			if ( store.named ) {

				Object.keys( store.named ).forEach( function ( name ) {

					const named = store.named[ name ];
					if ( named ) walk( named.versions );

				} );

			}

		}

		this.pendingMeshWrites.forEach( function ( _value, id ) {

			ids.add( id );

		} );

		this.redoDisposalCache.forEach( function ( record ) {

			walk( record.redoTail );

		} );

		return ids;

	}

	async gcUnreferencedMeshes( store ) {

		const keep = this.collectReferencedMeshIds( store );

		try {

			const db = await this.openMeshDb();
			const storeName = this.meshStoreName;
			const meshMemoryCache = this.meshMemoryCache;

			const existing = await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readonly' );
				const request = tx.objectStore( storeName ).getAllKeys();
				request.onsuccess = function () {

					resolve( request.result || [] );

				};

				request.onerror = function () {

					reject( request.error );

				};

			} );

			const toDelete = existing.filter( function ( id ) {

				return ! keep.has( id );

			} );

			if ( toDelete.length === 0 ) return;

			await new Promise( function ( resolve, reject ) {

				const tx = db.transaction( storeName, 'readwrite' );
				const objectStore = tx.objectStore( storeName );

				for ( let i = 0; i < toDelete.length; i ++ ) {

					objectStore.delete( toDelete[ i ] );
					meshMemoryCache.delete( toDelete[ i ] );

				}

				tx.oncomplete = function () {

					resolve();

				};

				tx.onerror = function () {

					reject( tx.error );

				};

			} );

		} catch ( e ) {

			console.warn( 'Failed to garbage-collect mesh IndexedDB entries', e );

		}

	}

	async resolveMeshGeometry( params, kind ) {

		const idKey = kind === 'cone' ? 'coneMeshId' : 'patternMeshId';
		const legacyKey = kind === 'cone' ? 'coneMesh' : 'patternMesh';

		if ( params[ idKey ] ) {

			const record = await this.getMeshRecord( params[ idKey ] );
			return deserializeBufferGeometry( record );

		}

		if ( params[ legacyKey ] ) {

			const record = migrateLegacyMeshSnapshot( params[ legacyKey ] );
			if ( ! record ) return null;

			const id = hashMeshRecord( record );
			this.queueMeshRecord( id, record );
			params[ idKey ] = id;
			delete params[ legacyKey ];
			return deserializeBufferGeometry( record );

		}

		return null;

	}

}

async function resolveMeshGeometry( params, kind, getMeshRecordFn, queueMeshRecordFn ) {

	const idKey = kind === 'cone' ? 'coneMeshId' : 'patternMeshId';
	const legacyKey = kind === 'cone' ? 'coneMesh' : 'patternMesh';

	if ( params[ idKey ] ) {

		const record = await getMeshRecordFn( params[ idKey ] );
		return deserializeBufferGeometry( record );

	}

	if ( params[ legacyKey ] ) {

		const record = migrateLegacyMeshSnapshot( params[ legacyKey ] );
		if ( ! record ) return null;

		const id = hashMeshRecord( record );
		if ( typeof queueMeshRecordFn === 'function' ) queueMeshRecordFn( id, record );
		params[ idKey ] = id;
		delete params[ legacyKey ];
		return deserializeBufferGeometry( record );

	}

	return null;

}

export {
	MeshIndexedDB,
	resolveMeshGeometry
};
