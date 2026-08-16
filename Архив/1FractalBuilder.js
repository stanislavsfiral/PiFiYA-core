import * as THREE from 'three';

// --- ГЕНЕРАЦИЯ ПРАВОГО ВИТКА СФИРАЛИ ---
export function generateRightBranch(R, H) {
    const mainPts = [];
    const junctionZ = H / 5;
    for (let i = 0; i <= 100; i++) {
        let t = i / 100;
        let angle = 2 * Math.PI * t;
        let x = R * Math.cos(angle);
        let y = R * Math.sin(angle);
        let z = junctionZ + (H - junctionZ) * (1 - t);
        mainPts.push(new THREE.Vector3(x, y, z));
    }
    const sPts = [];
    let r_s = R / 2;
    for (let i = 0; i <= 60; i++) {
        let t = i / 60;
        let angle = Math.PI * t;
        let x = r_s + r_s * Math.cos(angle);
        let y = r_s * Math.sin(angle);
        let z = junctionZ * (1 - t);
        sPts.push(new THREE.Vector3(x, y, z));
    }
    return { mainPts, sPts };
}

// --- ТРОИЧНЫЙ ПРОСТРАНСТВЕННЫЙ АЛГОРИТМ УОЛША ---
export class TernarySpatialWalshEngine {
    constructor() {
        this.active = false;
    }
    
    quantizeTernary(val) {
        const threshold = 0.3;
        if (Math.abs(val) < threshold) return 0;  
        return val > 0 ? 1 : -1;                  
    }

    evaluateNode(node, time) {
        let pX = Math.sin(time + node.x * 0.02);
        let pY = Math.sin(time + node.y * 0.02 + Math.PI / 3);
        let pZ = Math.sin(time + node.z * 0.02 + Math.PI / 1.5);

        let tensorVal = (pX + pY + pZ) / 3;
        let ternaryState = this.quantizeTernary(tensorVal);

        if (ternaryState === 1) {
            node.params.showRight = true;
            node.params.showS = true;
            node.params.showLeft = false;
            node.params.showSLeft = false;
        } else if (ternaryState === -1) {
            node.params.showRight = false;
            node.params.showS = false;
            node.params.showLeft = true;
            node.params.showSLeft = true;
        } else {
            node.params.showRight = true;
            node.params.showS = true;
            node.params.showLeft = true;
            node.params.showSLeft = true;
        }
        
        node.quantumState = {
            intensity: Math.abs(tensorVal),
            psi_real: pX,
            psi_imag: pY
        };
    }
}