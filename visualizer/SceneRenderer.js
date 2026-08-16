import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { generateHalfPoints } from '../core/GideonMath.js';

export class VisualizerScene {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.scene = new THREE.Scene();
        
        this.camera = new THREE.PerspectiveCamera(45, this.container.clientWidth / this.container.clientHeight, 1, 4000);
        this.camera.position.set(600, 450, 700);

        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.container.appendChild(this.renderer.domElement);

        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;

        this.scene.add(new THREE.AmbientLight(0xffffff, 0.9));
        this.spiralGroup = new THREE.Group();
        this.scene.add(this.spiralGroup);

        window.addEventListener('resize', () => this.onResize());
        this.buildDefaultSpiral();
    }

    buildDefaultSpiral() {
        const pts = generateHalfPoints(140, 190);
        const points = [];
        for (let i = 0; i < pts.x.length; i++) {
            points.push(new THREE.Vector3(pts.x[i], pts.y[i], pts.z[i]));
        }
        const geometry = new THREE.BufferGeometry().setFromPoints(points);
        const material = new THREE.LineBasicMaterial({ color: 0x00e5ff });
        this.spiralGroup.add(new THREE.Line(geometry, material));
    }

    onResize() {
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    renderFrame() {
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}