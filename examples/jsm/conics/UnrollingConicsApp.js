/**
 * Unrolling conics demo app: dual-panel cone/pattern editor with persistence.
 *
 * @module UnrollingConicsApp
 * @three_import import { initUnrollingConicsApp } from 'three/addons/conics/UnrollingConicsApp.js';
 */

import * as THREE from 'three/webgpu';
import { color } from 'three/tsl';
import { Inspector } from 'three/addons/inspector/Inspector.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';

import {
	fitConeFromFlatGeometry,
	measureFlatConeRoundTrip
} from './DevelopableConeMath.js';
import {
	createClippedConeGeometry,
	createConeGeometryFromPattern,
	createFlattenedConeGeometry,
	createFlattenedGeometryFromConeBuffer,
	getConeLocalClippingPlanes,
	updateLiftedConeGeometry
} from './ConeDevelopableGeometry.js';
import { flattenedGeometryToSVG, downloadSVG } from './PatternSVG.js';
import { createClayMaterial, createGlassMaterial, createPlainMaterial } from './WallMaterials.js';
import {
	serializeBufferGeometry,
	hashMeshRecord
} from './MeshSnapshotCodec.js';
import { MeshIndexedDB } from './MeshIndexedDB.js';
import {
	VersionedParamHistory,
	EMPTY_SELECT,
	AUTOSAVE_LABEL,
	formatSnapshotLabel
} from './VersionedParamHistory.js';

let canvas, renderer;
let renderRequested = false;
let rendererReady = false;

const scenes = [];

function requestRender() {

	if ( ! rendererReady || renderRequested ) return;

	renderRequested = true;
	requestAnimationFrame( function () {

		renderRequested = false;
		if ( rendererReady ) animate();

	} );

}

async function initUnrollingConicsApp() {

	canvas = document.getElementById( 'c' );

	let coneAngle = 0.4;
	let coneHeight = 5;
	const coneSegments = 64;
	let coneRadius = Math.tan( coneAngle ) * coneHeight;

	let coneGeometry = new THREE.ConeGeometry( coneRadius, coneHeight, coneSegments, 1, true );

	let cutAngle = 0.0;
	let showGroundPlane = true;
	let autoZoom = false;
	let patternFirst = false;
	let coneUsesParametricGeometry = true;
	let wallMaterial = 'clay';
	const WALL_MATERIALS = [ 'clay', 'glass', 'plain' ];
	let lastInverseDiagnostics = null;
	// Canonical cut definition in cone-rig space. Flattening always uses these.
	const localPlane1 = new THREE.Plane( new THREE.Vector3( Math.sin( cutAngle ), Math.cos( cutAngle ), 0 ), 2.0 );
	const localPlane2 = new THREE.Plane( new THREE.Vector3( - Math.sin( cutAngle ), - Math.cos( cutAngle ), 0 ), 2.0 );
	// World-space copies for ClippingGroup rendering (updated when the rig moves/rotates).
	const worldPlane1 = localPlane1.clone();
	const worldPlane2 = localPlane2.clone();
	const _fitPoint = new THREE.Vector3();
	const _fitDir = new THREE.Vector3();
	const _levelNormal = new THREE.Vector3();
	const _levelTarget = new THREE.Vector3();
	const _levelUp = new THREE.Vector3( 0, 1, 0 );
	const _levelQuat = new THREE.Quaternion();
	const AUTO_ZOOM_FILL = 0.9; // leave a 10% margin; only zoom out past this
	const titles = [ '3D Cone Sliced', 'Unrolled Pattern' ];
	const objectMaterials = [];
	const groundMaterials = [];
	const knotClippingGroups = [];
	let transformMode = null;
	let coneTransformControls = null;
	let moveToolButton = null;
	let rotateToolButton = null;
	let geometryModeBadge = null;
	const wallMaterials = {
		clay: createClayMaterial(),
		glass: createGlassMaterial(),
		plain: createPlainMaterial()
	};

	const content = document.getElementById( 'content' );
	const panelsRow = document.createElement( 'div' );
	panelsRow.className = 'panels-row';
	content.appendChild( panelsRow );

	const swapPanelsButton = document.createElement( 'button' );
	swapPanelsButton.type = 'button';
	swapPanelsButton.id = 'swap-panels';
	swapPanelsButton.className = 'tool-button swap-panels-button';
	swapPanelsButton.title = 'Pattern first — modify flat shape and lift to 3D cone';
	swapPanelsButton.setAttribute( 'aria-label', 'Swap panel order' );
	swapPanelsButton.setAttribute( 'aria-pressed', 'false' );
	swapPanelsButton.style.display = 'none';
	swapPanelsButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h11M4 7l4-4M4 7l4 4M20 17H9M20 17l-4-4M20 17l-4 4"/></svg>';

	for ( let i = 0; i < 2; i ++ ) {

		const scene = new THREE.Scene();
		scene.backgroundNode = color( 0xeeeeee );

		// make a list item
		const element = document.createElement( 'div' );
		element.className = 'list-item';

		const sceneElement = document.createElement( 'div' );
		element.appendChild( sceneElement );

		const headerElement = document.createElement( 'div' );
		headerElement.className = 'list-item-header';

		const descriptionElement = document.createElement( 'div' );
		descriptionElement.className = 'title';
		descriptionElement.innerText = titles[ i ];
		headerElement.appendChild( descriptionElement );

		if ( i === 0 ) {

			geometryModeBadge = document.createElement( 'span' );
			geometryModeBadge.className = 'geometry-mode-badge';
			geometryModeBadge.textContent = 'ConeGeometry';
			geometryModeBadge.title = 'Parametric cone — rebuilt from cone params';
			geometryModeBadge.style.display = 'none';
			descriptionElement.appendChild( geometryModeBadge );

		}

		element.appendChild( headerElement );

		// the element that represents the area we want to render the scene
		scene.userData.element = sceneElement;
		scene.userData.listItem = element;
		panelsRow.appendChild( element );

		const statsElement = document.createElement( 'div' );
		statsElement.className = 'stats';
		element.appendChild( statsElement );

		const camera = new THREE.PerspectiveCamera( 40, 1, 0.1, 200 );
		camera.position.z = 5;
		scene.userData.camera = camera;

		const controls = new OrbitControls( scene.userData.camera, scene.userData.element );
		controls.minDistance = 1;
		controls.maxDistance = 155;
		controls.enablePan = true;
		controls.enableZoom = true;
		controls.addEventListener( 'change', requestRender );
		scene.userData.controls = controls;

		const material = wallMaterials.clay;
		objectMaterials.push( material );

		let object;

		if ( i === 0 ) {

			const knotClippingGroup = new THREE.ClippingGroup();
			knotClippingGroup.clippingPlanes = [ worldPlane1, worldPlane2 ];
			knotClippingGroup.clipIntersection = false;
			knotClippingGroup.clipShadows = true;

			scene.add( knotClippingGroup );

			object = new THREE.Mesh( coneGeometry, wallMaterials.clay );
			object.castShadow = true;

			object.rotation.z = Math.PI;
			knotClippingGroup.add( object );
			scene.userData.coneMesh = object;
			knotClippingGroups.push( knotClippingGroup );

			const transformControls = new TransformControls( camera, sceneElement );
			transformControls.attach( knotClippingGroup );
			transformControls.enabled = false;
			transformControls.getHelper().visible = false;
			transformControls.addEventListener( 'dragging-changed', function ( event ) {

				controls.enabled = ! event.value;

			} );
			transformControls.addEventListener( 'objectChange', function () {

				syncClippingPlanesToWorld();
				requestRender();

			} );
			transformControls.addEventListener( 'change', requestRender );
			scene.add( transformControls.getHelper() );
			scene.userData.transformControls = transformControls;
			coneTransformControls = transformControls;

			const toolButtons = document.createElement( 'div' );
			toolButtons.className = 'tool-buttons';

			moveToolButton = document.createElement( 'button' );
			moveToolButton.type = 'button';
			moveToolButton.className = 'tool-button';
			moveToolButton.title = 'Move';
			moveToolButton.setAttribute( 'aria-label', 'Move' );
			moveToolButton.setAttribute( 'aria-pressed', 'false' );
			moveToolButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/></svg>';
			moveToolButton.addEventListener( 'click', function () {

				setTransformMode( transformMode === 'translate' ? null : 'translate' );

			} );

			rotateToolButton = document.createElement( 'button' );
			rotateToolButton.type = 'button';
			rotateToolButton.className = 'tool-button';
			rotateToolButton.title = 'Rotate';
			rotateToolButton.setAttribute( 'aria-label', 'Rotate' );
			rotateToolButton.setAttribute( 'aria-pressed', 'false' );
			rotateToolButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 12a7.5 7.5 0 0 1 12.8-5.3M19.5 12a7.5 7.5 0 0 1-12.8 5.3M17.3 4.5V8.2h-3.7M6.7 19.5v-3.7h3.7"/></svg>';
			rotateToolButton.addEventListener( 'click', function () {

				setTransformMode( transformMode === 'rotate' ? null : 'rotate' );

			} );

			const levelToolButton = document.createElement( 'button' );
			levelToolButton.type = 'button';
			levelToolButton.className = 'tool-button';
			levelToolButton.title = 'Level cuts to ground';
			levelToolButton.setAttribute( 'aria-label', 'Level cuts to ground' );
			levelToolButton.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12h18"/><path d="M6 8.5h12v7H6z"/><path d="M11 12h2"/></svg>';
			levelToolButton.addEventListener( 'click', function () {

				levelCutPlanesToGround();

			} );

			toolButtons.appendChild( moveToolButton );
			toolButtons.appendChild( rotateToolButton );
			toolButtons.appendChild( levelToolButton );
			headerElement.appendChild( toolButtons );

			scene.userData.statsElement = statsElement;
			camera.position.set( 0, 6, 9 );

			camera.lookAt( 0, 0, 0 );
			scene.userData.controls.target.set( 0, 0, 0 );
			scene.userData.controls.update();

		} else {

			const flattenedGeometry = createFlattenedConeGeometry( coneRadius, coneHeight, coneSegments, coneAngle, localPlane1, localPlane2, knotClippingGroups[ 0 ].enabled );
			object = new THREE.Mesh( flattenedGeometry, wallMaterials.clay );
			object.castShadow = true;
			object.rotation.z = Math.PI;
			object.position.y = -4.9;
			scene.add( object );
			scene.userData.flattenedMesh = object;
			scene.userData.statsElement = statsElement;

			const downloadButton = document.createElement( 'button' );
			downloadButton.type = 'button';
			downloadButton.className = 'download-svg';
			downloadButton.textContent = 'Download SVG';
			downloadButton.addEventListener( 'click', function () {

				const geometry = scene.userData.flattenedMesh.geometry;
				const svg = flattenedGeometryToSVG( geometry );
				downloadSVG( svg, 'unrolled-pattern.svg' );

			} );
			headerElement.appendChild( downloadButton );

			camera.position.set( 0, 1, 9 );
			camera.lookAt( 0, -5, 0 );
			scene.userData.controls.target.set( 0, -5, 0 );
			scene.userData.controls.update();
		}

		const ground = new THREE.Mesh(
			new THREE.PlaneGeometry( 20, 20, 20, 20 ),
			new THREE.MeshPhongNodeMaterial( { color: 0xa0adaf, shininess: 150, alphaToCoverage: true } )
		);

		ground.rotation.x = - Math.PI / 2;
		ground.position.y = - 5;
		ground.receiveShadow = true;
		ground.visible = showGroundPlane;
		scene.add( ground );

		const grid = new THREE.GridHelper( 20, 20, 0xcccccc, 0xaaaaaa );
		grid.position.y = - 5;
		grid.material.opacity = 0.75;
		grid.material.transparent = true;
		grid.visible = showGroundPlane;
		scene.add( grid );

		scene.userData.ground = ground;
		scene.userData.grid = grid;
		groundMaterials.push( ground.material );

		scene.add( new THREE.AmbientLight( 0xcccccc, 0.7 ) );

		const spotLight = new THREE.SpotLight( 0xffffff, 60 );
		spotLight.angle = Math.PI / 5;
		spotLight.penumbra = 0.2;
		spotLight.position.set( 0, -2, 0 );
		spotLight.castShadow = true;
		spotLight.shadow.mapType = THREE.HalfFloatType; // HDR caustics through transparent walls
		spotLight.shadow.camera.near = 1;
		spotLight.shadow.camera.far = 20;
		spotLight.shadow.mapSize.width = 2048;
		spotLight.shadow.mapSize.height = 2048;
		spotLight.shadow.radius = 4;
		scene.add( spotLight );

		const dirLight = new THREE.DirectionalLight( 0xffffff, 2.5 );
		dirLight.position.set( 4, 8, 5 );
		dirLight.castShadow = true;
		dirLight.shadow.mapType = THREE.HalfFloatType;
		// Ground is 20×20; keep the ortho frustum large enough in light space
		// (tilted light makes a too-small box project as a diamond on the ground).
		dirLight.shadow.camera.near = 0.5;
		dirLight.shadow.camera.far = 40;
		dirLight.shadow.camera.right = 18;
		dirLight.shadow.camera.left = - 18;
		dirLight.shadow.camera.top = 18;
		dirLight.shadow.camera.bottom = - 18;
		dirLight.shadow.camera.updateProjectionMatrix();

		dirLight.shadow.mapSize.width = 2048;
		dirLight.shadow.mapSize.height = 2048;
		scene.add( dirLight );

		const lightAbove = new THREE.PointLight( 0xffffff, 50, 50 );
		lightAbove.position.set( 3, 10, 4 );
		lightAbove.castShadow = true;
		lightAbove.shadow.mapType = THREE.HalfFloatType;
		lightAbove.shadow.mapSize.width = 1024;
		lightAbove.shadow.mapSize.height = 1024;
		lightAbove.shadow.camera.near = 0.5;
		lightAbove.shadow.camera.far = 50;
		scene.add( lightAbove );

		const lightAboveFill = new THREE.PointLight( 0xfff2e0, 30, 50 );
		lightAboveFill.position.set( - 4, 8, - 3 );
		lightAboveFill.castShadow = true;
		lightAboveFill.shadow.mapType = THREE.HalfFloatType;
		lightAboveFill.shadow.mapSize.width = 512;
		lightAboveFill.shadow.mapSize.height = 512;
		lightAboveFill.shadow.camera.near = 0.5;
		lightAboveFill.shadow.camera.far = 50;
		scene.add( lightAboveFill );

		const lightBelow = new THREE.PointLight( 0xffffff, 40, 50 );
		lightBelow.position.set( - 2, - 8, 3 );
		lightBelow.castShadow = true;
		lightBelow.shadow.mapType = THREE.HalfFloatType;
		lightBelow.shadow.mapSize.width = 1024;
		lightBelow.shadow.mapSize.height = 1024;
		lightBelow.shadow.camera.near = 0.5;
		lightBelow.shadow.camera.far = 50;
		scene.add( lightBelow );

		const lightBelowFill = new THREE.PointLight( 0xe0f0ff, 25, 50 );
		lightBelowFill.position.set( 4, - 6, - 4 );
		lightBelowFill.castShadow = true;
		lightBelowFill.shadow.mapType = THREE.HalfFloatType;
		lightBelowFill.shadow.mapSize.width = 512;
		lightBelowFill.shadow.mapSize.height = 512;
		lightBelowFill.shadow.camera.near = 0.5;
		lightBelowFill.shadow.camera.far = 50;
		scene.add( lightBelowFill );

		const dirLightBelow = new THREE.DirectionalLight( 0x888888, 1.5 );
		dirLightBelow.position.set( 0, - 10, 2 );
		dirLightBelow.castShadow = true;
		dirLightBelow.shadow.mapType = THREE.HalfFloatType;
		dirLightBelow.shadow.camera.near = 0.5;
		dirLightBelow.shadow.camera.far = 40;
		dirLightBelow.shadow.camera.right = 18;
		dirLightBelow.shadow.camera.left = - 18;
		dirLightBelow.shadow.camera.top = 18;
		dirLightBelow.shadow.camera.bottom = - 18;
		dirLightBelow.shadow.camera.updateProjectionMatrix();
		dirLightBelow.shadow.mapSize.width = 2048;
		dirLightBelow.shadow.mapSize.height = 2048;
		scene.add( dirLightBelow );

		scenes.push( scene );

	}

	// Place the swap control between the two panels.
	if ( scenes[ 1 ] && scenes[ 1 ].userData.listItem ) {

		panelsRow.insertBefore( swapPanelsButton, scenes[ 1 ].userData.listItem );

	} else {

		panelsRow.appendChild( swapPanelsButton );

	}

	renderer = new THREE.WebGPURenderer( { canvas: canvas, antialias: true } );
	renderer.shadowMap.enabled = true;
	renderer.setClearColor( 0xffffff, 1 );
	renderer.setPixelRatio( window.devicePixelRatio );
	renderer.inspector = new Inspector();

	await renderer.init();
	rendererReady = true;

	window.addEventListener( 'resize', requestRender );
	window.addEventListener( 'scroll', requestRender, { passive: true } );
	requestRender();

	scenes.forEach( updateStats );
	const gui = renderer.inspector.createParameters( 'Clipping settings' );
	const props = {
		alphaToCoverage: true,
	};

	const CONIC_VERSION_COOKIE = 'X-conic-version';

	let isRestoring = false;
	const meshDb = new MeshIndexedDB();
	const history = new VersionedParamHistory( {
		meshDb: meshDb,
		getParams: function () {

			return getParams();

		},
		applyParams: function ( params ) {

			return applyParams( params );

		},
		isRestoring: function () {

			return isRestoring;

		},
		onStoreChanged: function () {

			refreshPersistenceUI();

		}
	} );
	const conicEditors = {};
	const persistEditors = {};

	function getConicFeatureVersion() {

		const raw = document.cookie || '';
		if ( ! raw ) return 0;

		const parts = raw.split( ';' );
		for ( let i = 0; i < parts.length; i ++ ) {

			const piece = parts[ i ].trim();
			if ( ! piece ) continue;
			const eq = piece.indexOf( '=' );
			const name = eq === - 1 ? piece : piece.slice( 0, eq );
			if ( name !== CONIC_VERSION_COOKIE ) continue;
			const value = eq === - 1 ? '' : piece.slice( eq + 1 );
			const parsed = parseInt( decodeURIComponent( value ), 10 );
			return Number.isFinite( parsed ) ? parsed : 0;

		}

		return 0;

	}

	function isConicV2Enabled() {

		return getConicFeatureVersion() >= 2;

	}

	function isBufferGeometrySnapshot( params ) {

		if ( ! params ) return false;
		return !! (
			params.coneMeshId ||
			params.patternMeshId ||
			params.coneMesh ||
			params.patternMesh ||
			params.patternFirst ||
			params.coneUsesParametricGeometry === false
		);

	}

	function getParams() {

		const params = {
			applyCuts: knotClippingGroups[ 0 ].enabled,
			ClipShadows: knotClippingGroups[ 0 ].clipShadows,
			showGroundPlane: showGroundPlane,
			autoZoom: autoZoom,
			patternFirst: isConicV2Enabled() ? patternFirst : false,
			coneUsesParametricGeometry: isConicV2Enabled() ? coneUsesParametricGeometry : true,
			wallMaterial: wallMaterial,
			coneAngle: coneAngle,
			coneHeight: coneHeight,
			cutAngle: cutAngle,
			cutUpOffset: localPlane1.constant,
			cutDownOffset: localPlane2.constant
		};

		if ( isConicV2Enabled() && ! coneUsesParametricGeometry ) {

			if ( scenes[ 0 ] && scenes[ 0 ].userData.coneMesh ) {

				const coneSnapshot = serializeBufferGeometry( scenes[ 0 ].userData.coneMesh.geometry );
				if ( coneSnapshot ) {

					const id = hashMeshRecord( coneSnapshot );
					meshDb.queueMeshRecord( id, coneSnapshot );
					params.coneMeshId = id;

				}

			}

			if ( scenes[ 1 ] && scenes[ 1 ].userData.flattenedMesh ) {

				const patternSnapshot = serializeBufferGeometry( scenes[ 1 ].userData.flattenedMesh.geometry );
				if ( patternSnapshot ) {

					const id = hashMeshRecord( patternSnapshot );
					meshDb.queueMeshRecord( id, patternSnapshot );
					params.patternMeshId = id;

				}

			}

		}

		return params;

	}

	function replaceSelectOptions( editor, options, selectedValue ) {

		if ( ! editor ) return;

		editor.options = options;
		const select = editor.select;
		select.innerHTML = '';

		options.forEach( function ( opt ) {

			const optionEl = document.createElement( 'option' );
			optionEl.value = opt;
			optionEl.textContent = opt;
			select.appendChild( optionEl );

		} );

		const nextValue = options.includes( selectedValue ) ? selectedValue : ( options[ 0 ] || EMPTY_SELECT );
		editor.setValue( nextValue );

	}

	const folderConic = gui.addFolder( 'Conic Sections' );
	const folderScene = gui.addFolder( 'Scene' );
	const folderMaterial = gui.addFolder( 'Material' );
	const propsConic = {

		get applyCuts() {

			return knotClippingGroups[ 0 ].enabled;

		},

		set applyCuts( v ) {

			if ( isRestoring ) {

				knotClippingGroups.forEach( function ( group ) {

					group.enabled = v;

				} );
				return;

			}

			knotClippingGroups.forEach( function ( group ) {

				group.enabled = v;

			} );

			if ( coneUsesParametricGeometry && ! patternFirst ) {

				// Parametric cone: cuts are plane-clipped on the full cone and baked into the flat unroll.
				updateGeometries();

			} else {

				// Buffer mesh already carries the cut topology — only toggle clipping planes.
				syncClippingPlanesToWorld();
				scenes.forEach( updateStats );
				requestRender();

			}

			history.scheduleAutosave();

		},

		get 'ClipShadows'() {

			return knotClippingGroups[ 0 ].clipShadows;

		},

		set 'ClipShadows'( v ) {

			knotClippingGroups.forEach( function ( group ) {

				group.clipShadows = v;

			} );
			history.scheduleAutosave();

		},

		get showGroundPlane() {

			return showGroundPlane;

		},

		set showGroundPlane( v ) {

			showGroundPlane = v;
			updateGroundVisibility();
			history.scheduleAutosave();

		},

		get autoZoom() {

			return autoZoom;

		},

		set autoZoom( v ) {

			autoZoom = v;
			if ( autoZoom ) ensureConeFitsInView();
			history.scheduleAutosave();

		},

		get patternFirst() {

			return patternFirst;

		},

		set patternFirst( v ) {

			setPatternFirst( !! v );

		},

		get wallMaterial() {

			return wallMaterial;

		},

		set wallMaterial( v ) {

			const next = v === 'duck' ? 'glass' : v;
			wallMaterial = WALL_MATERIALS.includes( next ) ? next : 'clay';
			updateConeWallMaterial();
			history.scheduleAutosave();

		},

		get 'coneAngle'() {

			return coneAngle;

		},

		set 'coneAngle'( v ) {

			coneAngle = v;
			if ( isRestoring ) return;
			updateGeometries( patternFirst ? {} : { editCone: true } );
			ensureConeFitsInView();
			history.scheduleAutosave();

		},

		get 'coneHeight'() {

			return coneHeight;

		},

		set 'coneHeight'( v ) {

			coneHeight = v;
			if ( isRestoring ) return;
			updateGeometries( patternFirst ? {} : { editCone: true } );
			ensureConeFitsInView();
			history.scheduleAutosave();

		},

		get 'cutAngle'() {

			return cutAngle;

		},

		set 'cutAngle'( v ) {

			if ( isRestoring ) {

				cutAngle = v;
				return;

			}

			const wasLevelled = areCutPlanesLevelled();
			cutAngle = v;
			updateGeometries( patternFirst ? {} : { editPattern: true } );
			if ( wasLevelled ) levelCutPlanesToGround();
			history.scheduleAutosave();

		},

		get 'cutUpOffset'() {

			return localPlane1.constant;

		},

		set 'cutUpOffset'( v ) {

			localPlane1.constant = v;
			if ( isRestoring ) return;
			updateGeometries( patternFirst ? {} : { editPattern: true } );
			history.scheduleAutosave();

		},

		get 'cutDownOffset'() {

			return localPlane2.constant;

		},

		set 'cutDownOffset'( v ) {

			localPlane2.constant = v;
			if ( isRestoring ) return;
			updateGeometries( patternFirst ? {} : { editPattern: true } );
			history.scheduleAutosave();

		}

	};

	function updateSwapButtonState() {

		if ( ! swapPanelsButton ) return;

		const enabled = isConicV2Enabled();
		swapPanelsButton.style.display = enabled ? '' : 'none';
		if ( ! enabled ) {

			swapPanelsButton.classList.remove( 'active' );
			swapPanelsButton.setAttribute( 'aria-pressed', 'false' );
			return;

		}

		swapPanelsButton.classList.toggle( 'active', patternFirst );
		swapPanelsButton.setAttribute( 'aria-pressed', patternFirst ? 'true' : 'false' );
		swapPanelsButton.title = patternFirst
			? 'Cone first — modify 3D cone and flatten'
			: 'Pattern first — modify flat shape and lift to 3D cone';

	}

	function applyPanelOrder() {

		const coneItem = scenes[ 0 ].userData.listItem;
		const flatItem = scenes[ 1 ].userData.listItem;
		if ( ! coneItem || ! flatItem ) return;

		if ( patternFirst && isConicV2Enabled() ) {

			panelsRow.appendChild( flatItem );
			panelsRow.appendChild( swapPanelsButton );
			panelsRow.appendChild( coneItem );

		} else {

			panelsRow.appendChild( coneItem );
			panelsRow.appendChild( swapPanelsButton );
			panelsRow.appendChild( flatItem );

		}

		requestRender();

	}

	function setPatternFirst( next, options = {} ) {

		if ( next && ! isConicV2Enabled() ) next = false;

		const changed = patternFirst !== !! next;
		patternFirst = !! next;
		applyPanelOrder();
		updateSwapButtonState();
		updateConicEditorsMode();

		if ( changed && patternFirst && ! options.skipGeometryUpdate ) {

			// Keep the current flat pattern; fit and lift the unique matching cone.
			updateGeometries();
			if ( autoZoom ) ensureConeFitsInView();

		}

		if ( ! options.skipAutosave ) history.scheduleAutosave();

	}

	function updateConicEditorsMode() {

		const editors = [
			conicEditors.applyCuts,
			conicEditors.coneAngle,
			conicEditors.coneHeight,
			conicEditors.cutAngle,
			conicEditors.cutUpOffset,
			conicEditors.cutDownOffset
		];

		for ( let i = 0; i < editors.length; i ++ ) {

			const editor = editors[ i ];
			if ( ! editor ) continue;
			if ( patternFirst ) editor.hide();
			else editor.show();

		}

	}

	function applyFittedConeToState( fitted ) {

		const prevRestoring = isRestoring;
		isRestoring = true;
		coneAngle = fitted.coneAngle;
		coneHeight = fitted.height;
		coneRadius = fitted.radius;

		if ( conicEditors.coneAngle ) conicEditors.coneAngle.setValue( coneAngle );
		if ( conicEditors.coneHeight ) conicEditors.coneHeight.setValue( coneHeight );

		isRestoring = prevRestoring;

	}

	if ( swapPanelsButton ) {

		swapPanelsButton.addEventListener( 'click', function () {

			setPatternFirst( ! patternFirst );

		} );

	}

	updateSwapButtonState();
	conicEditors.applyCuts = folderConic.add( propsConic, 'applyCuts' );
	conicEditors.coneAngle = folderConic.add( propsConic, 'coneAngle', 0.1, Math.PI / 2 - 0.1 );
	conicEditors.coneHeight = folderConic.add( propsConic, 'coneHeight', 0.5, 40 );
	conicEditors.cutAngle = folderConic.add( propsConic, 'cutAngle', 0, Math.PI );
	conicEditors.cutUpOffset = folderConic.add( propsConic, 'cutUpOffset', - 3, 3 );
	conicEditors.cutDownOffset = folderConic.add( propsConic, 'cutDownOffset', - 3, 3 );
	updateConicEditorsMode();

	conicEditors.ClipShadows = folderScene.add( propsConic, 'ClipShadows' );
	conicEditors.showGroundPlane = folderScene.add( propsConic, 'showGroundPlane' );
	conicEditors.autoZoom = folderScene.add( propsConic, 'autoZoom' );

	conicEditors.wallMaterial = folderMaterial.add( propsConic, 'wallMaterial', WALL_MATERIALS );

	function updatePlaneNormals() {

		const normal1 = new THREE.Vector3( Math.sin( cutAngle ), Math.cos( cutAngle ), 0 ).normalize();
		const normal2 = new THREE.Vector3( - Math.sin( cutAngle ), - Math.cos( cutAngle ), 0 ).normalize();

		localPlane1.normal.copy( normal1 );
		localPlane2.normal.copy( normal2 );

	}

	function syncClippingPlanesToWorld() {

		const group = knotClippingGroups[ 0 ];
		if ( ! group ) return;

		group.updateMatrixWorld( true );
		worldPlane1.copy( localPlane1 ).applyMatrix4( group.matrixWorld );
		worldPlane2.copy( localPlane2 ).applyMatrix4( group.matrixWorld );

	}

	function areCutPlanesLevelled() {

		const group = knotClippingGroups[ 0 ];
		if ( ! group ) return false;

		group.updateMatrixWorld( true );
		_levelNormal.copy( localPlane1.normal ).transformDirection( group.matrixWorld ).normalize();

		return Math.abs( Math.abs( _levelNormal.dot( _levelUp ) ) - 1 ) < 1e-4;

	}

	function levelCutPlanesToGround() {

		const group = knotClippingGroups[ 0 ];
		if ( ! group ) return;

		group.updateMatrixWorld( true );
		_levelNormal.copy( localPlane1.normal ).transformDirection( group.matrixWorld ).normalize();

		_levelTarget.copy( _levelUp );
		if ( _levelNormal.dot( _levelUp ) < 0 ) _levelTarget.negate();

		if ( _levelNormal.distanceToSquared( _levelTarget ) < 1e-12 ) return;

		_levelQuat.setFromUnitVectors( _levelNormal, _levelTarget );
		group.quaternion.premultiply( _levelQuat );
		syncClippingPlanesToWorld();
		requestRender();

	}

	function setTransformMode( mode ) {

		transformMode = ( mode === 'translate' || mode === 'rotate' ) ? mode : null;

		if ( coneTransformControls ) {

			if ( transformMode ) {

				coneTransformControls.setMode( transformMode );
				coneTransformControls.enabled = true;
				coneTransformControls.getHelper().visible = true;

			} else {

				coneTransformControls.enabled = false;
				coneTransformControls.getHelper().visible = false;

			}

		}

		if ( moveToolButton ) {

			const active = transformMode === 'translate';
			moveToolButton.classList.toggle( 'active', active );
			moveToolButton.setAttribute( 'aria-pressed', active ? 'true' : 'false' );

		}

		if ( rotateToolButton ) {

			const active = transformMode === 'rotate';
			rotateToolButton.classList.toggle( 'active', active );
			rotateToolButton.setAttribute( 'aria-pressed', active ? 'true' : 'false' );

		}

		requestRender();

	}

	window.addEventListener( 'keydown', function ( event ) {

		const target = event.target;
		if ( target ) {

			const tag = target.tagName;
			if ( tag === 'TEXTAREA' || target.isContentEditable ) return;

			if ( tag === 'INPUT' ) {

				const type = ( target.type || 'text' ).toLowerCase();
				// Keep native undo for text fields (e.g. save name); allow history undo on number/range/etc.
				if ( type === 'text' || type === 'search' || type === 'password' || type === 'email' || type === 'url' || type === 'tel' ) return;

			}

		}

		if ( event.key === 'Escape' && transformMode ) {

			setTransformMode( null );
			return;

		}

		const mod = event.metaKey || event.ctrlKey;
		if ( ! mod ) return;

		const key = event.key.toLowerCase();
		if ( key !== 'z' ) return;

		event.preventDefault();

		if ( event.shiftKey ) {

			history.redoHistory().catch( function ( error ) {

				console.warn( 'Redo failed', error );

			} );

		} else {

			history.undoHistory().catch( function ( error ) {

				console.warn( 'Undo failed', error );

			} );

		}

	} );

	function updateGroundVisibility() {

		scenes.forEach( function ( scene ) {

			if ( scene.userData.ground ) scene.userData.ground.visible = showGroundPlane;
			if ( scene.userData.grid ) scene.userData.grid.visible = showGroundPlane;

		} );
		requestRender();

	}

	function updateConeWallMaterial() {

		const material = wallMaterials[ wallMaterial ] || wallMaterials.clay;

		scenes.forEach( function ( scene ) {

			if ( scene.userData.coneMesh ) scene.userData.coneMesh.material = material;
			if ( scene.userData.flattenedMesh ) scene.userData.flattenedMesh.material = material;

		} );
		requestRender();

	}

	function getMeshProjectedExtent( mesh, camera ) {

		const position = mesh.geometry.getAttribute( 'position' );
		if ( ! position || position.count === 0 ) return 0;

		mesh.updateWorldMatrix( true, false );
		camera.updateMatrixWorld();

		let maxExtent = 0;

		for ( let i = 0; i < position.count; i ++ ) {

			_fitPoint.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld ).project( camera );
			maxExtent = Math.max( maxExtent, Math.abs( _fitPoint.x ), Math.abs( _fitPoint.y ) );

		}

		return maxExtent;

	}

	function fitMeshInView( scene, mesh ) {

		if ( ! mesh || ! mesh.geometry ) return;

		const camera = scene.userData.camera;
		const controls = scene.userData.controls;
		if ( ! camera || ! controls ) return;

		const maxExtent = getMeshProjectedExtent( mesh, camera );
		if ( ! Number.isFinite( maxExtent ) || maxExtent <= AUTO_ZOOM_FILL ) return;

		const currentDistance = camera.position.distanceTo( controls.target );
		if ( currentDistance <= 0 ) return;

		_fitDir.copy( camera.position ).sub( controls.target ).normalize();

		// One corrective step using true mesh extent (not the AABB), then re-check once
		let distance = Math.min( currentDistance * ( maxExtent / AUTO_ZOOM_FILL ), controls.maxDistance );
		camera.position.copy( controls.target ).addScaledVector( _fitDir, distance );
		camera.updateMatrixWorld();

		const extentAfter = getMeshProjectedExtent( mesh, camera );
		if ( Number.isFinite( extentAfter ) && extentAfter > AUTO_ZOOM_FILL && distance < controls.maxDistance ) {

			distance = Math.min( distance * ( extentAfter / AUTO_ZOOM_FILL ), controls.maxDistance );
			camera.position.copy( controls.target ).addScaledVector( _fitDir, distance );

		}

		controls.update();

	}

	function ensureConeFitsInView() {

		if ( ! autoZoom ) return;

		for ( let i = 0; i < scenes.length; i ++ ) {

			const scene = scenes[ i ];
			fitMeshInView( scene, scene.userData.coneMesh );
			fitMeshInView( scene, scene.userData.flattenedMesh );

		}

		requestRender();

	}

	function updateGeometries( options = {} ) {

		coneRadius = Math.tan( coneAngle ) * coneHeight;
		updatePlaneNormals();
		syncClippingPlanesToWorld();

		const applyCuts = knotClippingGroups[ 0 ].enabled;
		const coneParams = {
			coneAngle: coneAngle,
			height: coneHeight,
			radius: coneRadius
		};
		const coneMesh = scenes[ 0 ].userData.coneMesh;
		const flatMesh = scenes[ 1 ] && scenes[ 1 ].userData.flattenedMesh;
		const keepConeBuffer = !! options.keepConeBuffer && coneMesh && coneMesh.geometry && ! coneUsesParametricGeometry;
		const keepPatternBuffer = !! options.keepPatternBuffer && flatMesh && flatMesh.geometry;

		let newConeGeometry = null;
		let newFlattenedGeometry = null;

		if ( keepConeBuffer || keepPatternBuffer ) {

			newConeGeometry = keepConeBuffer ? coneMesh.geometry : null;
			newFlattenedGeometry = keepPatternBuffer ? flatMesh.geometry : null;

			if ( ! newFlattenedGeometry && newConeGeometry ) {

				newFlattenedGeometry = createFlattenedGeometryFromConeBuffer( newConeGeometry, coneParams );

			}

			if ( ! newConeGeometry && newFlattenedGeometry ) {

				newConeGeometry = createConeGeometryFromPattern( newFlattenedGeometry, coneParams );
				if ( newConeGeometry ) coneUsesParametricGeometry = false;

			}

			if ( newFlattenedGeometry ) {

				lastInverseDiagnostics = measureFlatConeRoundTrip( newFlattenedGeometry, coneParams );

			}

		} else if ( patternFirst ) {

			// Pattern is frozen — fit the unique cone from flat (R, α) → (r, φ).
			if ( flatMesh && flatMesh.geometry && flatMesh.geometry.getAttribute( 'position' )
				&& flatMesh.geometry.getAttribute( 'position' ).count >= 3 ) {

				newFlattenedGeometry = flatMesh.geometry;

			} else {

				newFlattenedGeometry = createFlattenedConeGeometry( coneRadius, coneHeight, coneSegments, coneAngle, localPlane1, localPlane2, applyCuts );

			}

			const fitted = fitConeFromFlatGeometry( newFlattenedGeometry );
			applyFittedConeToState( fitted );
			const liftParams = {
				coneAngle: fitted.coneAngle,
				height: fitted.height,
				radius: fitted.radius,
				useFlatPositions: true
			};
			newConeGeometry = createConeGeometryFromPattern( newFlattenedGeometry, liftParams );
			if ( newConeGeometry ) {

				coneUsesParametricGeometry = false;
				lastInverseDiagnostics = measureFlatConeRoundTrip( newFlattenedGeometry, liftParams );

			} else {

				newConeGeometry = new THREE.ConeGeometry( coneRadius, coneHeight, coneSegments, 1, true );
				coneUsesParametricGeometry = true;
				lastInverseDiagnostics = null;

			}

		} else if ( options.editPattern && ! coneUsesParametricGeometry ) {

			// Cone-first buffer: cut / section params reshape the flat pattern, then re-lift.
			newFlattenedGeometry = createFlattenedConeGeometry( coneRadius, coneHeight, coneSegments, coneAngle, localPlane1, localPlane2, applyCuts );
			newConeGeometry = createConeGeometryFromPattern( newFlattenedGeometry, coneParams );
			if ( newConeGeometry ) {

				lastInverseDiagnostics = measureFlatConeRoundTrip( newFlattenedGeometry, coneParams );

			} else {

				newConeGeometry = new THREE.ConeGeometry( coneRadius, coneHeight, coneSegments, 1, true );
				newFlattenedGeometry = createFlattenedConeGeometry( coneRadius, coneHeight, coneSegments, coneAngle, localPlane1, localPlane2, applyCuts );
				coneUsesParametricGeometry = true;
				lastInverseDiagnostics = null;

			}

		} else if ( coneUsesParametricGeometry ) {

			// Cone-first parametric (including cut edits): ConeGeometry + clipping; cuts bake into the flat.
			newConeGeometry = new THREE.ConeGeometry( coneRadius, coneHeight, coneSegments, 1, true );
			newFlattenedGeometry = createFlattenedConeGeometry( coneRadius, coneHeight, coneSegments, coneAngle, localPlane1, localPlane2, applyCuts );
			lastInverseDiagnostics = null;

		} else {

			// Cone-first buffer + cone size edit: remesh the 3D buffer, then unroll it.
			const sourceGeometry = coneMesh && coneMesh.geometry;
			const sourcePositions = sourceGeometry && sourceGeometry.getAttribute( 'position' );
			const sourceUvs = sourceGeometry && sourceGeometry.getAttribute( 'uv' );
			const canRemesh = sourcePositions && sourceUvs && sourcePositions.count >= 3;

			if ( canRemesh ) {

				updateLiftedConeGeometry( sourceGeometry, coneParams );
				newConeGeometry = sourceGeometry;
				newFlattenedGeometry = createFlattenedGeometryFromConeBuffer( newConeGeometry, coneParams );

			}

			if ( ! newConeGeometry || ! newFlattenedGeometry ) {

				newConeGeometry = new THREE.ConeGeometry( coneRadius, coneHeight, coneSegments, 1, true );
				newFlattenedGeometry = createFlattenedConeGeometry( coneRadius, coneHeight, coneSegments, coneAngle, localPlane1, localPlane2, applyCuts );
				coneUsesParametricGeometry = true;
				lastInverseDiagnostics = null;

			} else {

				lastInverseDiagnostics = measureFlatConeRoundTrip( newFlattenedGeometry, coneParams );

			}

		}

		scenes.forEach( function ( scene ) {

			if ( scene.userData.coneMesh && newConeGeometry ) {

				const mesh = scene.userData.coneMesh;
				if ( mesh.geometry !== newConeGeometry ) {

					mesh.geometry.dispose();
					mesh.geometry = newConeGeometry;

				}

				mesh.rotation.z = Math.PI;

			}

			if ( scene.userData.flattenedMesh && newFlattenedGeometry ) {

				const mesh = scene.userData.flattenedMesh;
				if ( mesh.geometry !== newFlattenedGeometry ) {

					mesh.geometry.dispose();
					mesh.geometry = newFlattenedGeometry;

				}

			}

		} );

		scenes.forEach( updateStats );
		updateGeometryModeBadge();
		if ( autoZoom ) ensureConeFitsInView();
		else requestRender();

	}

	function updateGeometryModeBadge() {

		if ( ! geometryModeBadge ) return;

		if ( ! isConicV2Enabled() ) {

			geometryModeBadge.style.display = 'none';
			return;

		}

		geometryModeBadge.style.display = '';

		if ( coneUsesParametricGeometry ) {

			geometryModeBadge.textContent = 'ConeGeometry';
			geometryModeBadge.classList.remove( 'is-buffer' );
			geometryModeBadge.title = 'Parametric cone is source — flat pattern is unrolled from the cone formula';

		} else if ( patternFirst ) {

			geometryModeBadge.textContent = 'BufferGeometry';
			geometryModeBadge.classList.add( 'is-buffer' );
			geometryModeBadge.title = 'Pattern-first — flat pattern fixed; 3D cone is fitted from (R, α) → (r, φ)';

		} else {

			geometryModeBadge.textContent = 'BufferGeometry';
			geometryModeBadge.classList.add( 'is-buffer' );
			geometryModeBadge.title = 'Cone-first buffer — cone size remeshes 3D; cut params rebuild the flat pattern and re-lift';

		}

	}

	function syncConicEditors() {

		const params = getParams();

		if ( conicEditors.applyCuts ) conicEditors.applyCuts.setValue( params.applyCuts );
		if ( conicEditors.ClipShadows ) conicEditors.ClipShadows.setValue( params.ClipShadows );
		if ( conicEditors.showGroundPlane ) conicEditors.showGroundPlane.setValue( params.showGroundPlane );
		if ( conicEditors.autoZoom ) conicEditors.autoZoom.setValue( params.autoZoom );
		if ( conicEditors.wallMaterial ) conicEditors.wallMaterial.setValue( params.wallMaterial );
		if ( conicEditors.coneAngle ) conicEditors.coneAngle.setValue( params.coneAngle );
		if ( conicEditors.coneHeight ) conicEditors.coneHeight.setValue( params.coneHeight );
		if ( conicEditors.cutAngle ) conicEditors.cutAngle.setValue( params.cutAngle );
		if ( conicEditors.cutUpOffset ) conicEditors.cutUpOffset.setValue( params.cutUpOffset );
		if ( conicEditors.cutDownOffset ) conicEditors.cutDownOffset.setValue( params.cutDownOffset );

	}

	async function applyParams( params ) {

		if ( ! params ) return;

		isRestoring = true;

		try {

			if ( 'applyCuts' in params || 'Enabled' in params ) {

				const applyCuts = 'applyCuts' in params ? params.applyCuts : params.Enabled;

				knotClippingGroups.forEach( function ( group ) {

					group.enabled = applyCuts;

				} );

			}

			if ( 'ClipShadows' in params ) {

				knotClippingGroups.forEach( function ( group ) {

					group.clipShadows = params.ClipShadows;

				} );

			}

			if ( 'showGroundPlane' in params ) {

				showGroundPlane = params.showGroundPlane;
				updateGroundVisibility();

			}

			if ( 'autoZoom' in params ) autoZoom = params.autoZoom;

			if ( isConicV2Enabled() ) {

				if ( 'patternFirst' in params ) {

					setPatternFirst( params.patternFirst, { skipGeometryUpdate: true, skipAutosave: true } );

				} else if ( 'rebuildFromPattern' in params && params.rebuildFromPattern ) {

					setPatternFirst( true, { skipGeometryUpdate: true, skipAutosave: true } );

				}

			} else {

				setPatternFirst( false, { skipGeometryUpdate: true, skipAutosave: true } );

			}

			if ( 'wallMaterial' in params ) {

				const next = params.wallMaterial === 'duck' ? 'glass' : params.wallMaterial;
				wallMaterial = WALL_MATERIALS.includes( next ) ? next : 'clay';
				updateConeWallMaterial();

			}

			const sizeChanged = ( 'coneAngle' in params && params.coneAngle !== coneAngle )
				|| ( 'coneHeight' in params && params.coneHeight !== coneHeight );
			const cutAngleChanging = ( 'cutAngle' in params && params.cutAngle !== cutAngle );
			const wasLevelled = cutAngleChanging && areCutPlanesLevelled();

			if ( 'coneAngle' in params ) coneAngle = params.coneAngle;
			if ( 'coneHeight' in params ) coneHeight = params.coneHeight;
			if ( 'cutAngle' in params ) cutAngle = params.cutAngle;
			if ( 'cutUpOffset' in params ) localPlane1.constant = params.cutUpOffset;
			if ( 'cutDownOffset' in params ) localPlane2.constant = params.cutDownOffset;

			let restoredConeMesh = false;
			let restoredPatternMesh = false;

			if ( isConicV2Enabled() ) {

				if ( 'coneUsesParametricGeometry' in params ) {

					coneUsesParametricGeometry = !! params.coneUsesParametricGeometry;

				}

				const restoredConeGeometry = await meshDb.resolveMeshGeometry( params, 'cone' );

				if ( restoredConeGeometry && scenes[ 0 ] && scenes[ 0 ].userData.coneMesh ) {

					const mesh = scenes[ 0 ].userData.coneMesh;
					mesh.geometry.dispose();
					mesh.geometry = restoredConeGeometry;
					coneUsesParametricGeometry = false;
					restoredConeMesh = true;

				} else if ( patternFirst ) {

					coneUsesParametricGeometry = false;

				} else {

					// Buffer flag/mesh missing — stay on parametric cone-first.
					coneUsesParametricGeometry = true;

				}

				const restoredPatternGeometry = await meshDb.resolveMeshGeometry( params, 'pattern' );

				if ( restoredPatternGeometry && scenes[ 1 ] && scenes[ 1 ].userData.flattenedMesh ) {

					const mesh = scenes[ 1 ].userData.flattenedMesh;
					mesh.geometry.dispose();
					mesh.geometry = restoredPatternGeometry;
					restoredPatternMesh = true;

				}

			} else {

				coneUsesParametricGeometry = true;

			}

			updateGeometries( {
				keepConeBuffer: restoredConeMesh,
				keepPatternBuffer: restoredPatternMesh
			} );
			if ( wasLevelled ) levelCutPlanesToGround();
			if ( sizeChanged ) ensureConeFitsInView();
			syncConicEditors();

		} finally {

			isRestoring = false;

		}

	}

	history.store = history.loadStore();
	await meshDb.loadRedoDisposalCache();
	await history.recoverPendingAutosaves();
	if ( history.store.autosave.length ) {

		let restoreEntry = history.store.autosave[ 0 ];

		if ( ! isConicV2Enabled() ) {

			restoreEntry = history.store.autosave.find( function ( entry ) {

				return ! isBufferGeometrySnapshot( entry && entry.params );

			} ) || null;

		}

		if ( restoreEntry ) await applyParams( restoreEntry.params );

	}

	// Migrate legacy inline meshes into IndexedDB and keep only ids in localStorage.
	if ( history.store.autosave[ 0 ] ) {

		history.store.autosave[ 0 ] = { t: history.store.autosave[ 0 ].t || Date.now(), params: getParams() };

	}

	history.store.pending.length = 0;
	await history.saveStore();

	const folderPersist = gui.addFolder( 'Persistence' );
	const propsPersist = {
		name: '',
		load: EMPTY_SELECT,
		version: EMPTY_SELECT,
		async Save() {

			const name = propsPersist.name.trim();
			if ( ! name || name === AUTOSAVE_LABEL || name === EMPTY_SELECT ) return;

			if ( ! history.store.named[ name ] ) {

				history.store.named[ name ] = { versions: [] };

			}

			history.pushVersion( history.store.named[ name ].versions, { t: Date.now(), params: getParams() } );
			await history.saveStore();
			propsPersist.load = name;
			refreshPersistenceUI( true );

		},
		async Load() {

			const loadName = propsPersist.load;
			const versions = history.getVersionsForLoad( loadName );
			const index = parseInt( propsPersist.version, 10 );
			if ( ! Number.isFinite( index ) || index < 0 || ! versions[ index ] ) return;
			if ( ! isConicV2Enabled() && isBufferGeometrySnapshot( versions[ index ].params ) ) return;

			await applyParams( versions[ index ].params );

			if ( loadName === AUTOSAVE_LABEL ) {

				setSaveNameInput( '' );

			} else if ( loadName && loadName !== EMPTY_SELECT ) {

				setSaveNameInput( loadName );

			}

		},
		async Reset() {

			isRestoring = true;

			try {

				setPatternFirst( false, { skipGeometryUpdate: true, skipAutosave: true } );
				setTransformMode( null );

				coneUsesParametricGeometry = true;
				lastInverseDiagnostics = null;
				coneAngle = 0.4;
				coneHeight = 5;
				coneRadius = Math.tan( coneAngle ) * coneHeight;
				cutAngle = 0.0;
				localPlane1.constant = 2.0;
				localPlane2.constant = 2.0;
				updatePlaneNormals();

				knotClippingGroups.forEach( function ( group ) {

					group.enabled = true;
					group.clipShadows = true;
					group.position.set( 0, 0, 0 );
					group.rotation.set( 0, 0, 0 );
					group.quaternion.identity();
					group.scale.set( 1, 1, 1 );
					group.updateMatrixWorld( true );

				} );

				syncClippingPlanesToWorld();
				updateGeometries();
				updateConicEditorsMode();
				syncConicEditors();

			} finally {

				isRestoring = false;

			}

			if ( autoZoom ) ensureConeFitsInView();
			history.scheduleAutosave();

		},
		async Delete() {

			const name = propsPersist.load;
			if ( ! name || name === EMPTY_SELECT ) return;

			if ( name === AUTOSAVE_LABEL ) {

				history.store.autosave = [];
				history.store.pending = [];
				history.historyIndex = 0;
				history.historyAtAutosave = false;
				await meshDb.clearRedoDisposal();

			} else if ( history.store.named[ name ] ) {

				delete history.store.named[ name ];

			} else {

				return;

			}

			await history.saveStore();
			propsPersist.load = EMPTY_SELECT;
			propsPersist.version = EMPTY_SELECT;
			refreshPersistenceUI();

		}
	};

	persistEditors.name = folderPersist.add( propsPersist, 'name' ).name( 'name of save' );
	persistEditors.Save = folderPersist.add( propsPersist, 'Save' );
	persistEditors.load = folderPersist.add( propsPersist, 'load', [ EMPTY_SELECT, AUTOSAVE_LABEL ] ).name( 'load save' );
	persistEditors.version = folderPersist.add( propsPersist, 'version', [ EMPTY_SELECT ] );
	persistEditors.Load = folderPersist.add( propsPersist, 'Load' );
	persistEditors.Reset = folderPersist.add( propsPersist, 'Reset' );
	persistEditors.Delete = folderPersist.add( propsPersist, 'Delete' );

	const persistenceSeparator = document.createElement( 'hr' );
	persistenceSeparator.className = 'persistence-separator';
	persistenceSeparator.setAttribute( 'aria-hidden', 'true' );
	const loadRow = persistEditors.Load.domElement.closest( '.list-item-wrapper' );
	const resetRow = persistEditors.Reset.domElement.closest( '.list-item-wrapper' );
	if ( loadRow && resetRow && resetRow.parentNode ) {

		resetRow.parentNode.insertBefore( persistenceSeparator, resetRow );

	}

	persistEditors.load.onChange( function () {

		refreshVersionSelect();

	} );

	function setSaveNameInput( name ) {

		propsPersist.name = name;
		if ( persistEditors.name ) persistEditors.name.setValue( name );

	}

	function refreshVersionSelect( selectLatest = false ) {

		const versions = history.getVersionsForLoad( propsPersist.load );
		const visible = [];

		for ( let i = 0; i < versions.length; i ++ ) {

			const entry = versions[ i ];
			if ( ! isConicV2Enabled() && isBufferGeometrySnapshot( entry && entry.params ) ) continue;
			visible.push( {
				value: String( i ),
				label: formatSnapshotLabel( entry, i, versions.length )
			} );

		}

		const options = visible.length
			? visible.map( function ( item ) {

				return item.value;

			} )
			: [ EMPTY_SELECT ];
		const labelsByValue = {};
		visible.forEach( function ( item ) {

			labelsByValue[ item.value ] = item.label;

		} );

		if ( ! persistEditors.version ) return;

		const editor = persistEditors.version;
		editor.options = options;
		const select = editor.select;
		select.innerHTML = '';

		options.forEach( function ( opt ) {

			const optionEl = document.createElement( 'option' );
			optionEl.value = opt;
			optionEl.textContent = opt === EMPTY_SELECT ? EMPTY_SELECT : ( labelsByValue[ opt ] || opt );
			select.appendChild( optionEl );

		} );

		const preferred = ( ! selectLatest && options.includes( propsPersist.version ) )
			? propsPersist.version
			: options[ 0 ];
		propsPersist.version = preferred;
		editor.setValue( preferred );

	}

	function refreshPersistenceUI( selectLatestVersion = false ) {

		if ( ! persistEditors.load ) return;

		const names = Object.keys( history.store.named ).sort();
		const loadOptions = [ EMPTY_SELECT, AUTOSAVE_LABEL ].concat( names );
		const selectedLoad = loadOptions.includes( propsPersist.load ) ? propsPersist.load : EMPTY_SELECT;
		propsPersist.load = selectedLoad;
		replaceSelectOptions( persistEditors.load, loadOptions, selectedLoad );

		refreshVersionSelect( selectLatestVersion );

	}

	refreshPersistenceUI();
	history.startAutosaveFlushTimer();

	function computeBoundingBoxSizes( geometry ) {

		const positions = geometry.getAttribute( 'position' );
		const count = positions.count;

		if ( count === 0 ) return new THREE.Vector3();

		const mean = new THREE.Vector3();
		for ( let i = 0; i < count; i ++ ) {
			mean.x += positions.getX( i );
			mean.y += positions.getY( i );
			mean.z += positions.getZ( i );
		}
		mean.multiplyScalar( 1 / count );

		const covariance = [ [ 0, 0, 0 ], [ 0, 0, 0 ], [ 0, 0, 0 ] ];
		for ( let i = 0; i < count; i ++ ) {
			const dx = positions.getX( i ) - mean.x;
			const dy = positions.getY( i ) - mean.y;
			const dz = positions.getZ( i ) - mean.z;
			covariance[ 0 ][ 0 ] += dx * dx;
			covariance[ 0 ][ 1 ] += dx * dy;
			covariance[ 0 ][ 2 ] += dx * dz;
			covariance[ 1 ][ 1 ] += dy * dy;
			covariance[ 1 ][ 2 ] += dy * dz;
			covariance[ 2 ][ 2 ] += dz * dz;
		}

		const scalar = 1 / count;
		covariance[ 0 ][ 0 ] *= scalar;
		covariance[ 0 ][ 1 ] *= scalar;
		covariance[ 0 ][ 2 ] *= scalar;
		covariance[ 1 ][ 1 ] *= scalar;
		covariance[ 1 ][ 2 ] *= scalar;
		covariance[ 2 ][ 2 ] *= scalar;
		covariance[ 1 ][ 0 ] = covariance[ 0 ][ 1 ];
		covariance[ 2 ][ 0 ] = covariance[ 0 ][ 2 ];
		covariance[ 2 ][ 1 ] = covariance[ 1 ][ 2 ];

		const result = jacobiEigenDecomposition( covariance );
		const axisX = new THREE.Vector3( result.vectors[ 0 ][ 0 ], result.vectors[ 1 ][ 0 ], result.vectors[ 2 ][ 0 ] ).normalize();
		const axisY = new THREE.Vector3( result.vectors[ 0 ][ 1 ], result.vectors[ 1 ][ 1 ], result.vectors[ 2 ][ 1 ] ).normalize();
		const axisZ = new THREE.Vector3( result.vectors[ 0 ][ 2 ], result.vectors[ 1 ][ 2 ], result.vectors[ 2 ][ 2 ] ).normalize();

		const min = new THREE.Vector3( Infinity, Infinity, Infinity );
		const max = new THREE.Vector3( - Infinity, - Infinity, - Infinity );

		for ( let i = 0; i < count; i ++ ) {
			const position = new THREE.Vector3( positions.getX( i ), positions.getY( i ), positions.getZ( i ) ).sub( mean );
			min.x = Math.min( min.x, position.dot( axisX ) );
			max.x = Math.max( max.x, position.dot( axisX ) );
			min.y = Math.min( min.y, position.dot( axisY ) );
			max.y = Math.max( max.y, position.dot( axisY ) );
			min.z = Math.min( min.z, position.dot( axisZ ) );
			max.z = Math.max( max.z, position.dot( axisZ ) );
		}

		return new THREE.Vector3( max.x - min.x, max.y - min.y, max.z - min.z );

	}

	function jacobiEigenDecomposition( matrix ) {

		const a = [
			[ matrix[ 0 ][ 0 ], matrix[ 0 ][ 1 ], matrix[ 0 ][ 2 ] ],
			[ matrix[ 1 ][ 0 ], matrix[ 1 ][ 1 ], matrix[ 1 ][ 2 ] ],
			[ matrix[ 2 ][ 0 ], matrix[ 2 ][ 1 ], matrix[ 2 ][ 2 ] ]
		];
		const v = [
			[ 1, 0, 0 ],
			[ 0, 1, 0 ],
			[ 0, 0, 1 ]
		];

		for ( let iteration = 0; iteration < 50; iteration ++ ) {
			let p = 0;
			let q = 1;
			let max = Math.abs( a[ 0 ][ 1 ] );
			if ( Math.abs( a[ 0 ][ 2 ] ) > max ) { p = 0; q = 2; max = Math.abs( a[ 0 ][ 2 ] ); }
			if ( Math.abs( a[ 1 ][ 2 ] ) > max ) { p = 1; q = 2; max = Math.abs( a[ 1 ][ 2 ] ); }

			if ( max < 1e-12 ) break;

			const app = a[ p ][ p ];
			const aqq = a[ q ][ q ];
			const apq = a[ p ][ q ];
			const phi = 0.5 * Math.atan2( 2 * apq, aqq - app );
			const c = Math.cos( phi );
			const s = Math.sin( phi );

			const app1 = c * c * app - 2 * s * c * apq + s * s * aqq;
			const aqq1 = s * s * app + 2 * s * c * apq + c * c * aqq;
			a[ p ][ p ] = app1;
			a[ q ][ q ] = aqq1;
			a[ p ][ q ] = 0;
			a[ q ][ p ] = 0;

			for ( let r = 0; r < 3; r ++ ) {
				if ( r === p || r === q ) continue;

				const arp = a[ Math.min( r, p ) ][ Math.max( r, p ) ];
				const arq = a[ Math.min( r, q ) ][ Math.max( r, q ) ];
				const arp1 = c * arp - s * arq;
				const arq1 = s * arp + c * arq;

				if ( r < p ) a[ r ][ p ] = arp1;
				else a[ p ][ r ] = arp1;

				if ( r < q ) a[ r ][ q ] = arq1;
				else a[ q ][ r ] = arq1;
			}

			for ( let r = 0; r < 3; r ++ ) {
				const vrp = v[ r ][ p ];
				const vrq = v[ r ][ q ];
				v[ r ][ p ] = c * vrp - s * vrq;
				v[ r ][ q ] = s * vrp + c * vrq;
			}
		}

		return { values: [ a[ 0 ][ 0 ], a[ 1 ][ 1 ], a[ 2 ][ 2 ] ], vectors: v };

	}

	function computeSurfacePlaneMaxAngle( geometry, plane1, plane2 ) {

		const positions = geometry.getAttribute( 'position' );
		const index = geometry.index;
		const count = index ? index.count : positions.count;
		const vA = new THREE.Vector3();
		const vB = new THREE.Vector3();
		const vC = new THREE.Vector3();
		const normal = new THREE.Vector3();
		let maxAngle = 0;

		const planeNormals = [ plane1.normal, plane2.normal ];

		for ( let i = 0; i < count; i += 3 ) {
			const aIndex = index ? index.getX( i ) : i;
			const bIndex = index ? index.getX( i + 1 ) : i + 1;
			const cIndex = index ? index.getX( i + 2 ) : i + 2;

			vA.set( positions.getX( aIndex ), positions.getY( aIndex ), positions.getZ( aIndex ) );
			vB.set( positions.getX( bIndex ), positions.getY( bIndex ), positions.getZ( bIndex ) );
			vC.set( positions.getX( cIndex ), positions.getY( cIndex ), positions.getZ( cIndex ) );

			normal.subVectors( vB, vA ).cross( vC.clone().sub( vA ) ).normalize();

			for ( let j = 0; j < planeNormals.length; j ++ ) {
				const angle = Math.abs( Math.PI / 2 - normal.angleTo( planeNormals[ j ] ) );
				maxAngle = Math.max( maxAngle, angle );
			}
		}

		return maxAngle;

	}

	function formatNumber( value ) {

		return value.toFixed( 2 );

	}

	function updateStats( scene ) {

		const statsElement = scene.userData.statsElement;
		if ( ! statsElement ) return;

		let text = '';

		if ( scene.userData.coneMesh ) {

			if ( ( patternFirst || ! coneUsesParametricGeometry ) && lastInverseDiagnostics ) {

				const d = lastInverseDiagnostics;
				const triangles = scene.userData.coneMesh.geometry.index
					? scene.userData.coneMesh.geometry.index.count / 3
					: scene.userData.coneMesh.geometry.getAttribute( 'position' ).count / 3;
				text = 'Inverse mesh triangles: ' + triangles + '\n';
				text += 'Round-trip max error: ' + d.maxError.toFixed( 6 ) + '\n';
				text += 'r range: ' + d.minR.toFixed( 3 ) + ' … ' + d.maxR.toFixed( 3 );
				if ( patternFirst && d.params ) {

					text += '\nFitted α: ' + ( d.params.coneAngle * 180 / Math.PI ).toFixed( 2 ) + '°';
					text += '  r_base: ' + d.params.radius.toFixed( 3 );
					text += '  h: ' + d.params.height.toFixed( 3 );

				}
				if ( d.outOfRangeCount > 0 ) {

					text += '\nOut-of-range vertices (r > radius): ' + d.outOfRangeCount;

				}

			} else {

				const localPlanes = getConeLocalClippingPlanes( localPlane1, localPlane2 );
				const clippedConeGeometry = createClippedConeGeometry( coneRadius, coneHeight, coneSegments, localPlane1, localPlane2 );
				const size = computeBoundingBoxSizes( clippedConeGeometry );
				const maxAngle = computeSurfacePlaneMaxAngle( clippedConeGeometry, localPlanes[ 0 ], localPlanes[ 1 ] );
				text = 'Oriented bounding box: ' + formatNumber( size.x ) + ' × ' + formatNumber( size.y ) + ' × ' + formatNumber( size.z ) + '\n';
				text += 'Max surface-plane angle: ' + ( ( maxAngle * 180 / Math.PI ).toFixed( 1 ) ) + '°';
				clippedConeGeometry.dispose();

			}

		}

		if ( scene.userData.flattenedMesh ) {

			const flattenedGeometry = scene.userData.flattenedMesh.geometry;
			flattenedGeometry.computeBoundingBox();
			const size = new THREE.Vector3();
			flattenedGeometry.boundingBox.getSize( size );
			const triangles = flattenedGeometry.index ? flattenedGeometry.index.count / 3 : flattenedGeometry.getAttribute( 'position' ).count / 3;
			text = 'Triangles: ' + triangles + '\n';
			text += 'Bounding box: ' + formatNumber( size.x ) + ' × ' + formatNumber( size.y ) + ' × ' + formatNumber( size.z );

			if ( patternFirst ) {

				const fitted = fitConeFromFlatGeometry( flattenedGeometry );
				text += '\nFlat sector φ: ' + ( fitted.sectorAngle * 180 / Math.PI ).toFixed( 2 ) + '°';
				text += '\nR range: ' + fitted.minR.toFixed( 3 ) + ' … ' + fitted.maxR.toFixed( 3 );
				text += '\nFit: r = R/k, φ = α·k, k = 1/sin(α) = ' + fitted.k.toFixed( 4 );
				text += '\n→ α ' + ( fitted.coneAngle * 180 / Math.PI ).toFixed( 2 ) + '°, r_base ' + fitted.radius.toFixed( 3 );

			}

		}

		statsElement.innerText = text;

	}

	// Unique right circular cone fitting a flat developable net:
	// flat polar (R, α) ↔ cone (r, φ) via k = 1/sin(α_cone), r = R/k, φ = α*k.
	// Sector angle φ_flat = 2π sin(α_cone) when the net covers a full 2π of generators.

}

function updateSize() {

	const width = canvas.clientWidth;
	const height = canvas.clientHeight;

	if ( canvas.width !== width || canvas.height !== height ) {

		renderer.setSize( width, height, false );

	}

}

function animate() {

	updateSize();

	canvas.style.transform = `translateY(${window.scrollY}px)`;

	renderer.setClearColor( 0xffffff );
	renderer.setScissorTest( false );
	renderer.setViewport( 0, 0, canvas.width, canvas.height );
	renderer.clear();

	//renderer.setClearColor( 0xe0e0e0 );
	renderer.setScissorTest( true );

	scenes.forEach( function ( scene ) {

		// so something moves
		//scene.children[ 0 ].rotation.y = Date.now() * 0.001;

		// get the element that is a place holder for where we want to
		// draw the scene
		const element = scene.userData.element;

		// get its position relative to the page's viewport
		const rect = element.getBoundingClientRect();

		// check if it's offscreen. If so skip it
		if ( rect.bottom < 0 || rect.top > renderer.domElement.clientHeight ||
			rect.right < 0 || rect.left > renderer.domElement.clientWidth ) {

			return; // it's off screen

		}

		// set the viewport
		const width = rect.right - rect.left;
		const height = rect.bottom - rect.top;
		const left = rect.left;
		const top = rect.top;

		renderer.setViewport( left, top, width, height );
		renderer.setScissor( left, top, width, height );

		const camera = scene.userData.camera;

		//camera.aspect = width / height; // not changing in this example
		//camera.updateProjectionMatrix();

		//scene.userData.controls.update();

		renderer.render( scene, camera );

	} );

}


export { initUnrollingConicsApp };
