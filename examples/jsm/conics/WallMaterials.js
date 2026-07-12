import * as THREE from 'three/webgpu';
import {
	color,
	div,
	float,
	Fn,
	mx_fractal_noise_float,
	mx_noise_float,
	mx_worley_noise_float,
	normalView,
	positionLocal,
	positionView,
	positionViewDirection,
	refract,
	smoothstep,
	texture,
	uniform,
	vec2,
	vec3
} from 'three/tsl';

/**
 * Wall materials for the multi-element / developable cone demo.
 *
 * @module WallMaterials
 * @three_import import { createClayMaterial, createGlassMaterial, createPlainMaterial } from 'three/addons/conics/WallMaterials.js';
 */

// Procedural height → normals via screen-space derivatives.
// bumpMap only works with UV-sampled textures, not position-based noise.
function bumpNormal( height ) {

	const dpdx = positionView.dFdx();
	const dpdy = positionView.dFdy();
	const r1 = dpdy.cross( normalView );
	const r2 = normalView.cross( dpdx );
	const det = dpdx.dot( r1 );
	const grad = det.sign().mul( height.dFdx().mul( r1 ).add( height.dFdy().mul( r2 ) ) );

	return det.abs().mul( normalView ).sub( grad ).normalize();

}

function createClayMaterial() {

	const material = new THREE.MeshStandardNodeMaterial( {

		side: THREE.DoubleSide,
		alphaToCoverage: true,
		metalness: 0,
		roughness: 0.97

	} );

	// Hand-worked clay: soft Worley thumbprints + multi-scale Perlin kneading + fine tooth
	const p = positionLocal;
	const pits = mx_worley_noise_float( p.mul( 1.7 ) ).mul( 0.6 )
		.add( mx_worley_noise_float( p.mul( 2.9 ).add( 13.7 ) ).mul( 0.4 ) );
	const softPits = smoothstep( 0.06, 0.5, pits );

	const knead = mx_fractal_noise_float( p.mul( 0.7 ), 4 ).mul( 0.45 )
		.add( mx_noise_float( p.mul( 2.4 ) ).mul( 0.3 ) )
		.add( mx_noise_float( p.mul( 6.5 ) ).mul( 0.25 ) );
	const waves = knead.mul( 0.5 ).add( 0.5 );

	const grain = mx_noise_float( p.mul( 48 ) );

	const height = softPits.mul( 0.45 ).add( waves.mul( 0.5 ) ).add( grain.mul( 0.05 ) );

	material.colorNode = color( 0xb8957e );
	material.roughnessNode = float( 0.95 ).add( grain.mul( 0.04 ) );
	material.normalNode = bumpNormal( height.mul( 0.08 ) );

	return material;

}

function createGlassMaterial() {

	const causticMap = new THREE.TextureLoader().load( './textures/opengameart/Caustic_Free.jpg' );
	causticMap.wrapS = causticMap.wrapT = THREE.RepeatWrapping;
	causticMap.colorSpace = THREE.SRGBColorSpace;

	const material = new THREE.MeshPhysicalNodeMaterial();
	material.side = THREE.DoubleSide;
	material.transparent = true;
	material.opacity = 0.6;
	material.color = new THREE.Color().setHSL( Math.random(), 0.75, 0.55 );
	// transmission uses a fullscreen buffer that breaks under multi-viewport scissor rendering
	material.transmission = 0;
	material.thickness = 0.25;
	material.ior = 1.5;
	material.metalness = 0;
	material.roughness = 0.08;
	material.specularIntensity = 1;

	const causticOcclusion = uniform( 20 );
	const causticColor = uniform( material.color );

	material.castShadowPositionNode = Fn( () => {

		return positionLocal;

	} )();

	material.castShadowNode = Fn( () => {

		const refractionVector = refract( positionViewDirection.negate(), normalView, div( 1.0, material.ior ) ).normalize();
		const viewZ = normalView.z.pow( causticOcclusion );
		const textureUV = refractionVector.xy.mul( 0.6 );
		const chromaticAberrationOffset = normalView.z.pow( - 0.9 ).mul( 0.004 );

		const causticProjection = vec3(
			texture( causticMap, textureUV.add( vec2( chromaticAberrationOffset.negate(), 0 ) ) ).r,
			texture( causticMap, textureUV.add( vec2( 0, chromaticAberrationOffset.negate() ) ) ).g,
			texture( causticMap, textureUV.add( vec2( chromaticAberrationOffset, chromaticAberrationOffset ) ) ).b
		);

		return causticProjection.mul( viewZ.mul( 25 ) ).add( viewZ ).mul( causticColor );

	} )();

	return material;

}

function createPlainMaterial() {

	return new THREE.MeshStandardNodeMaterial( {

		color: new THREE.Color().setHSL( Math.random(), 0.75, 0.55 ),
		side: THREE.DoubleSide,
		alphaToCoverage: true,
		metalness: 0,
		roughness: 0.45

	} );

}

export { createClayMaterial, createGlassMaterial, createPlainMaterial };
