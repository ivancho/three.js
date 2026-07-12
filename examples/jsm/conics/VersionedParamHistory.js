/**
 * localStorage versioned param history with undo/redo and debounced autosave.
 *
 * @module VersionedParamHistory
 * @three_import import { VersionedParamHistory, paramsEqual } from 'three/addons/conics/VersionedParamHistory.js';
 */

const EMPTY_SELECT = '—';
const AUTOSAVE_LABEL = '<autosave>';

function paramsEqual( a, b ) {

	if ( ! a || ! b ) return false;

	return a.applyCuts === b.applyCuts &&
		a.ClipShadows === b.ClipShadows &&
		a.showGroundPlane === b.showGroundPlane &&
		a.autoZoom === b.autoZoom &&
		a.patternFirst === b.patternFirst &&
		a.coneUsesParametricGeometry === b.coneUsesParametricGeometry &&
		a.wallMaterial === b.wallMaterial &&
		a.coneAngle === b.coneAngle &&
		a.coneHeight === b.coneHeight &&
		a.cutAngle === b.cutAngle &&
		a.cutUpOffset === b.cutUpOffset &&
		a.cutDownOffset === b.cutDownOffset &&
		a.coneMeshId === b.coneMeshId &&
		a.patternMeshId === b.patternMeshId;

}

function formatSnapshotLabel( entry, index, length ) {

	return ( length - 1 - index ) + ' · ' + new Date( entry.t ).toLocaleString();

}

function createEmptyStore() {

	return { autosave: [], pending: [], named: {} };

}

function paramsForLocalStorage( params ) {

	if ( ! params ) return params;

	const next = Object.assign( {}, params );
	delete next.coneMesh;
	delete next.patternMesh;
	return next;

}

function sanitizeSnapshotList( list ) {

	if ( ! Array.isArray( list ) ) return;

	for ( let i = 0; i < list.length; i ++ ) {

		const entry = list[ i ];
		if ( ! entry || ! entry.params ) continue;
		if ( ! entry.params.coneMesh && ! entry.params.patternMesh ) continue;
		list[ i ] = { t: entry.t, params: paramsForLocalStorage( entry.params ) };

	}

}

function readIsRestoring( isRestoring ) {

	if ( typeof isRestoring === 'function' ) return !! isRestoring();
	if ( isRestoring && typeof isRestoring.get === 'function' ) return !! isRestoring.get();
	return !! isRestoring;

}

class VersionedParamHistory {

	constructor( {
		storageKey = 'threejs.webgpu_multiple_elements.params',
		historyLimit = 20,
		autosaveDebounceMs = 150,
		autosaveFlushMs = 60_000,
		pendingAutosaveLimit = 30,
		meshDb,
		getParams,
		applyParams,
		paramsEqual: paramsEqualFn = paramsEqual,
		isRestoring,
		onStoreChanged
	} = {} ) {

		this.storageKey = storageKey;
		this.historyLimit = historyLimit;
		this.autosaveDebounceMs = autosaveDebounceMs;
		this.autosaveFlushMs = autosaveFlushMs;
		this.pendingAutosaveLimit = pendingAutosaveLimit;
		this.meshDb = meshDb;
		this.getParams = getParams;
		this.applyParams = applyParams;
		this.paramsEqual = paramsEqualFn;
		this._isRestoring = isRestoring;
		this.onStoreChanged = onStoreChanged;

		this._autosaveDebounceTimer = null;
		this._autosaveFlushTimer = null;
		this._store = createEmptyStore();
		this._historyIndex = 0;
		this._historyAtAutosave = false;

	}

	get store() {

		return this._store;

	}

	set store( value ) {

		this._store = value;

	}

	get historyIndex() {

		return this._historyIndex;

	}

	set historyIndex( value ) {

		this._historyIndex = value;

	}

	get historyAtAutosave() {

		return this._historyAtAutosave;

	}

	set historyAtAutosave( value ) {

		this._historyAtAutosave = value;

	}

	_restoring() {

		return readIsRestoring( this._isRestoring );

	}

	createEmptyStore() {

		return createEmptyStore();

	}

	paramsForLocalStorage( params ) {

		return paramsForLocalStorage( params );

	}

	sanitizeStoreInlineMeshes( target = this._store ) {

		sanitizeSnapshotList( target.autosave );
		sanitizeSnapshotList( target.pending );

		if ( target.named ) {

			Object.keys( target.named ).forEach( function ( name ) {

				const named = target.named[ name ];
				if ( named && Array.isArray( named.versions ) ) sanitizeSnapshotList( named.versions );

			} );

		}

	}

	loadStore() {

		try {

			const raw = localStorage.getItem( this.storageKey );
			if ( ! raw ) return createEmptyStore();

			const parsed = JSON.parse( raw );
			if ( ! parsed || typeof parsed !== 'object' ) return createEmptyStore();

			const next = {
				autosave: Array.isArray( parsed.autosave ) ? parsed.autosave : [],
				pending: Array.isArray( parsed.pending ) ? parsed.pending : [],
				named: parsed.named && typeof parsed.named === 'object' ? parsed.named : {}
			};
			this.sanitizeStoreInlineMeshes( next );
			this._store = next;
			return next;

		} catch ( e ) {

			console.warn( 'Failed to load params from localStorage', e );
			this._store = createEmptyStore();
			return this._store;

		}

	}

	async saveStore() {

		this.sanitizeStoreInlineMeshes( this._store );

		if ( this.meshDb ) {

			try {

				await this.meshDb.flushMeshWrites();

			} catch ( e ) {

				// Still try to persist scalar snapshot keys.

			}

		}

		try {

			localStorage.setItem( this.storageKey, JSON.stringify( this._store ) );

		} catch ( e ) {

			this._store.pending.length = Math.min( this._store.pending.length, 1 );
			this._store.autosave.length = Math.min( this._store.autosave.length, 5 );

			try {

				localStorage.setItem( this.storageKey, JSON.stringify( this._store ) );
				console.warn( 'localStorage quota hit; trimmed history and retried', e );

			} catch ( e2 ) {

				console.warn( 'Failed to save params to localStorage', e2 );
				return false;

			}

		}

		if ( this.meshDb ) {

			await this.meshDb.gcUnreferencedMeshes( this._store );

		}

		return true;

	}

	pushVersion( list, snapshot, limit = this.historyLimit ) {

		const entry = {
			t: snapshot.t,
			params: paramsForLocalStorage( snapshot.params )
		};
		list.unshift( entry );
		if ( list.length > limit ) list.length = limit;

	}

	formatSnapshotLabel( entry, index, length ) {

		return formatSnapshotLabel( entry, index, length );

	}

	getVersionsForLoad( name ) {

		if ( name === AUTOSAVE_LABEL ) return this._store.autosave;
		if ( name && name !== EMPTY_SELECT && this._store.named[ name ] ) return this._store.named[ name ].versions;
		return [];

	}

	scheduleAutosave() {

		if ( this._restoring() ) return;

		const self = this;
		clearTimeout( this._autosaveDebounceTimer );
		this._autosaveDebounceTimer = setTimeout( function () {

			self.capturePendingAutosave().catch( function ( error ) {

				console.warn( 'Autosave failed', error );

			} );

		}, this.autosaveDebounceMs );

	}

	async capturePendingAutosave() {

		if ( this._restoring() ) return;

		let peeledTail = null;
		const store = this._store;

		if ( this._historyAtAutosave ) {

			// Branched from the autosave floor — peel the whole pending chain for possible undo restore.
			if ( store.pending.length > 0 ) {

				const meshDb = this.meshDb;
				peeledTail = store.pending.map( function ( entry ) {

					return meshDb ? meshDb.snapshotForDisposal( entry ) : {
						t: entry.t,
						params: paramsForLocalStorage( entry.params )
					};

				} ).filter( Boolean );

			}

			store.pending.length = 0;
			this._historyAtAutosave = false;
			this._historyIndex = 0;

		} else if ( this._historyIndex > 0 ) {

			// Peel redo futures newer than the restored snapshot into disposal.
			const meshDb = this.meshDb;
			peeledTail = store.pending.slice( 0, this._historyIndex ).map( function ( entry ) {

				return meshDb ? meshDb.snapshotForDisposal( entry ) : {
					t: entry.t,
					params: paramsForLocalStorage( entry.params )
				};

			} ).filter( Boolean );
			store.pending.splice( 0, this._historyIndex );
			this._historyIndex = 0;

		}

		const params = this.getParams();
		if ( store.pending[ 0 ] && this.paramsEqual( store.pending[ 0 ].params, params ) ) return;
		if ( ! store.pending[ 0 ] && store.autosave[ 0 ] && this.paramsEqual( store.autosave[ 0 ].params, params ) ) return;

		const peelTimestamp = Date.now();
		this.pushVersion( store.pending, { t: peelTimestamp, params: params }, this.pendingAutosaveLimit );
		this._historyIndex = 0;
		this._historyAtAutosave = false;

		if ( peeledTail && peeledTail.length > 0 && this.meshDb ) {

			await this.meshDb.putRedoDisposal( {
				peelTimestamp: peelTimestamp,
				peeledAt: peelTimestamp,
				redoTail: peeledTail
			} );

		}

		await this.saveStore();

	}

	async flushPendingAutosave() {

		if ( this._restoring() ) return;

		clearTimeout( this._autosaveDebounceTimer );
		this._autosaveDebounceTimer = null;
		await this.capturePendingAutosave();

		const store = this._store;
		if ( store.pending.length === 0 ) return;

		const snapshot = store.pending[ 0 ];
		store.pending.length = 0;
		this._historyIndex = 0;
		this._historyAtAutosave = false;

		if ( this.meshDb ) {

			await this.meshDb.clearRedoDisposal();

		}

		if ( ! store.autosave[ 0 ] || ! this.paramsEqual( store.autosave[ 0 ].params, snapshot.params ) ) {

			this.pushVersion( store.autosave, { t: Date.now(), params: snapshot.params } );

		}

		await this.saveStore();

		if ( typeof this.onStoreChanged === 'function' ) this.onStoreChanged();

	}

	async recoverPendingAutosaves() {

		const store = this._store;
		if ( store.pending.length === 0 ) return;

		const snapshot = store.pending[ 0 ];
		store.pending.length = 0;
		this._historyIndex = 0;
		this._historyAtAutosave = false;

		if ( this.meshDb ) {

			await this.meshDb.clearRedoDisposal();

		}

		if ( ! store.autosave[ 0 ] || ! this.paramsEqual( store.autosave[ 0 ].params, snapshot.params ) ) {

			this.pushVersion( store.autosave, {
				t: snapshot.t || Date.now(),
				params: snapshot.params
			} );

		}

		await this.saveStore();

	}

	async undoHistory() {

		if ( this._restoring() ) return;

		// Snapshot the live tip before stepping back, unless we're already mid-history.
		if ( this._historyIndex === 0 && ! this._historyAtAutosave ) {

			await this.capturePendingAutosave();

		}

		if ( this._historyAtAutosave ) return;

		const store = this._store;

		// If this tip peeled a redo chain, undoing it restores that chain.
		if ( this._historyIndex === 0 && store.pending[ 0 ] && this.meshDb ) {

			const tip = store.pending[ 0 ];
			const disposal = await this.meshDb.getRedoDisposal( tip.t );

			if ( disposal && Array.isArray( disposal.redoTail ) && disposal.redoTail.length > 0 ) {

				const rest = store.pending.slice( 1 );
				// Keep the peeled tip as the newest redo target: [tip, ...tail, ...older]
				store.pending = [ tip ].concat( disposal.redoTail, rest );
				this._historyIndex = 1 + disposal.redoTail.length;
				this._historyAtAutosave = false;
				await this.meshDb.deleteRedoDisposal( tip.t );
				await this.saveStore();

				if ( this._historyIndex >= store.pending.length ) {

					this._historyIndex = Math.max( 0, store.pending.length - 1 );

				}

				if ( store.pending[ this._historyIndex ] ) {

					await this.applyParams( store.pending[ this._historyIndex ].params );
					return;

				}

			}

		}

		if ( store.pending.length === 0 || store.pending.length === 1 || this._historyIndex >= store.pending.length - 1 ) {

			if ( ! store.autosave[ 0 ] ) return;

			this._historyAtAutosave = true;
			await this.applyParams( store.autosave[ 0 ].params );
			return;

		}

		this._historyIndex ++;
		this._historyAtAutosave = false;
		await this.applyParams( store.pending[ this._historyIndex ].params );

	}

	async redoHistory() {

		if ( this._restoring() ) return;

		const store = this._store;

		if ( this._historyAtAutosave ) {

			if ( store.pending.length === 0 ) return;

			this._historyAtAutosave = false;
			this._historyIndex = store.pending.length - 1;
			await this.applyParams( store.pending[ this._historyIndex ].params );
			return;

		}

		if ( this._historyIndex <= 0 ) return;

		this._historyIndex --;
		await this.applyParams( store.pending[ this._historyIndex ].params );

	}

	startAutosaveFlushTimer() {

		if ( this._autosaveFlushTimer !== null ) return;

		const self = this;

		this._autosaveFlushTimer = setInterval( function () {

			self.flushPendingAutosave().catch( function ( error ) {

				console.warn( 'Autosave flush failed', error );

			} );

		}, this.autosaveFlushMs );

		if ( typeof window !== 'undefined' ) {

			window.addEventListener( 'beforeunload', function () {

				// Best-effort: kick off flush; IndexedDB may not finish before unload.
				self.flushPendingAutosave();

			} );

		}

	}

}

export {
	VersionedParamHistory,
	paramsEqual,
	formatSnapshotLabel,
	createEmptyStore,
	paramsForLocalStorage,
	EMPTY_SELECT,
	AUTOSAVE_LABEL
};
