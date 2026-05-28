/**
 * 水下特效系统：气泡轨迹 + 水花飞溅
 * 依赖 Three.js (通过 importmap 引入)
 */
import * as THREE from 'three';

// ═══════════════════════════════════════════════════════
// 气泡系统 (Bubble Trail)
// ═══════════════════════════════════════════════════════

const BUBBLE_MAX = 300;
const BUBBLE_VERTEX = `
    attribute float aSize;
    attribute float aAlpha;
    varying float vAlpha;
    void main() {
        vAlpha = aAlpha;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (200.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;
const BUBBLE_FRAGMENT = `
    varying float vAlpha;
    void main() {
        // 圆形气泡 + 边缘高光
        vec2 uv = gl_PointCoord - 0.5;
        float dist = length(uv);
        if (dist > 0.5) discard;
        // 气泡效果：中心半透明，边缘亮圈
        float ring = smoothstep(0.35, 0.45, dist) * smoothstep(0.5, 0.42, dist);
        float inner = smoothstep(0.5, 0.0, dist) * 0.3;
        float highlight = smoothstep(0.25, 0.15, length(uv - vec2(-0.15, 0.15))) * 0.6;
        float alpha = (ring * 0.8 + inner + highlight) * vAlpha;
        gl_FragColor = vec4(0.7, 0.9, 1.0, alpha);
    }
`;

export class BubbleSystem {
    constructor(scene) {
        this.scene = scene;
        this.count = 0;

        // 属性缓冲
        this.positions = new Float32Array(BUBBLE_MAX * 3);
        this.sizes = new Float32Array(BUBBLE_MAX);
        this.alphas = new Float32Array(BUBBLE_MAX);
        this.velocities = new Float32Array(BUBBLE_MAX * 3); // vx, vy, vz
        this.ages = new Float32Array(BUBBLE_MAX);
        this.lifetimes = new Float32Array(BUBBLE_MAX);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
        geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));

        const material = new THREE.ShaderMaterial({
            vertexShader: BUBBLE_VERTEX,
            fragmentShader: BUBBLE_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        this.mesh = new THREE.Points(geometry, material);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }

    /**
     * 从指定位置发射气泡
     * @param {number} x - 世界坐标 X
     * @param {number} y - 世界坐标 Y
     * @param {number} count - 发射数量
     * @param {object} opts - 可选参数 { sizeMin, sizeMax, speedUp, spread }
     */
    emit(x, y, count = 1, opts = {}) {
        const { sizeMin = 1.5, sizeMax = 4.0, speedUp = 15, spread = 5 } = opts;
        for (let i = 0; i < count; i++) {
            if (this.count >= BUBBLE_MAX) break;
            const idx = this.count;
            this.positions[idx * 3] = x + (Math.random() - 0.5) * spread;
            this.positions[idx * 3 + 1] = y + (Math.random() - 0.5) * spread * 0.5;
            this.positions[idx * 3 + 2] = (Math.random() - 0.5) * 5;
            this.velocities[idx * 3] = (Math.random() - 0.5) * 3; // slight horizontal drift
            this.velocities[idx * 3 + 1] = speedUp * (0.6 + Math.random() * 0.4); // upward
            this.velocities[idx * 3 + 2] = 0;
            this.sizes[idx] = sizeMin + Math.random() * (sizeMax - sizeMin);
            this.alphas[idx] = 0.8 + Math.random() * 0.2;
            this.ages[idx] = 0;
            this.lifetimes[idx] = 1.5 + Math.random() * 2.0; // 1.5~3.5秒
            this.count++;
        }
    }

    update(dt) {
        let alive = 0;
        for (let i = 0; i < this.count; i++) {
            this.ages[i] += dt;
            if (this.ages[i] >= this.lifetimes[i]) continue; // 死亡
            // 物理更新
            // 水平漂移加 wobble
            this.velocities[i * 3] += (Math.random() - 0.5) * 8 * dt;
            this.velocities[i * 3] *= 0.96; // 阻尼
            this.positions[i * 3] += this.velocities[i * 3] * dt;
            this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
            // 上浮速度随时间微减
            this.velocities[i * 3 + 1] *= 0.995;
            // 气泡变大（膨胀）
            this.sizes[i] *= 1.0 + dt * 0.3;
            // 透明度淡出
            const life = this.ages[i] / this.lifetimes[i];
            this.alphas[i] = (1.0 - life * life) * 0.9;
            // 压缩到前面
            if (alive !== i) {
                this.positions[alive * 3] = this.positions[i * 3];
                this.positions[alive * 3 + 1] = this.positions[i * 3 + 1];
                this.positions[alive * 3 + 2] = this.positions[i * 3 + 2];
                this.velocities[alive * 3] = this.velocities[i * 3];
                this.velocities[alive * 3 + 1] = this.velocities[i * 3 + 1];
                this.velocities[alive * 3 + 2] = this.velocities[i * 3 + 2];
                this.sizes[alive] = this.sizes[i];
                this.alphas[alive] = this.alphas[i];
                this.ages[alive] = this.ages[i];
                this.lifetimes[alive] = this.lifetimes[i];
            }
            alive++;
        }
        this.count = alive;
        // 清空死亡区域
        for (let i = alive; i < BUBBLE_MAX; i++) {
            this.alphas[i] = 0;
        }
        // 更新 GPU 缓冲
        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.aSize.needsUpdate = true;
        this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
        this.mesh.geometry.setDrawRange(0, this.count);
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

// ═══════════════════════════════════════════════════════
// 水花飞溅系统 (Splash Particles)
// ═══════════════════════════════════════════════════════

const SPLASH_MAX = 150;
const SPLASH_VERTEX = `
    attribute float aSize;
    attribute float aAlpha;
    attribute vec3 aColor;
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
        vAlpha = aAlpha;
        vColor = aColor;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        gl_PointSize = aSize * (200.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;
const SPLASH_FRAGMENT = `
    varying float vAlpha;
    varying vec3 vColor;
    void main() {
        float dist = length(gl_PointCoord - 0.5);
        if (dist > 0.5) discard;
        // 水滴形状：中心亮，边缘柔和
        float alpha = smoothstep(0.5, 0.1, dist) * vAlpha;
        gl_FragColor = vec4(vColor, alpha);
    }
`;

export class SplashSystem {
    constructor(scene) {
        this.scene = scene;
        this.count = 0;

        this.positions = new Float32Array(SPLASH_MAX * 3);
        this.sizes = new Float32Array(SPLASH_MAX);
        this.alphas = new Float32Array(SPLASH_MAX);
        this.colors = new Float32Array(SPLASH_MAX * 3);
        this.velocities = new Float32Array(SPLASH_MAX * 3);
        this.ages = new Float32Array(SPLASH_MAX);
        this.lifetimes = new Float32Array(SPLASH_MAX);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
        geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
        geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
        geometry.setAttribute('aColor', new THREE.BufferAttribute(this.colors, 3));

        const material = new THREE.ShaderMaterial({
            vertexShader: SPLASH_VERTEX,
            fragmentShader: SPLASH_FRAGMENT,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
        });

        this.mesh = new THREE.Points(geometry, material);
        this.mesh.frustumCulled = false;
        scene.add(this.mesh);
    }

    /**
     * 在指定位置爆发水花
     * @param {number} x - 世界坐标 X
     * @param {number} y - 世界坐标 Y
     * @param {object} opts - { count, power, color }
     */
    burst(x, y, opts = {}) {
        const { count = 20, power = 80, color = [0.6, 0.85, 1.0] } = opts;
        for (let i = 0; i < count; i++) {
            if (this.count >= SPLASH_MAX) break;
            const idx = this.count;
            this.positions[idx * 3] = x;
            this.positions[idx * 3 + 1] = y;
            this.positions[idx * 3 + 2] = (Math.random() - 0.5) * 3;
            // 向上为主的扇形发射
            const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.8;
            const speed = power * (0.4 + Math.random() * 0.6);
            this.velocities[idx * 3] = Math.cos(angle) * speed;
            this.velocities[idx * 3 + 1] = Math.sin(angle) * speed;
            this.velocities[idx * 3 + 2] = 0;
            this.sizes[idx] = 2 + Math.random() * 4;
            this.alphas[idx] = 0.9;
            this.colors[idx * 3] = color[0] + (Math.random() - 0.5) * 0.1;
            this.colors[idx * 3 + 1] = color[1] + (Math.random() - 0.5) * 0.1;
            this.colors[idx * 3 + 2] = color[2] + (Math.random() - 0.5) * 0.1;
            this.ages[idx] = 0;
            this.lifetimes[idx] = 0.4 + Math.random() * 0.6; // 短寿命 0.4~1.0s
            this.count++;
        }
    }

    update(dt) {
        const GRAVITY = -120; // 向下重力
        let alive = 0;
        for (let i = 0; i < this.count; i++) {
            this.ages[i] += dt;
            if (this.ages[i] >= this.lifetimes[i]) continue;
            // 物理
            this.velocities[i * 3 + 1] += GRAVITY * dt; // 重力
            this.positions[i * 3] += this.velocities[i * 3] * dt;
            this.positions[i * 3 + 1] += this.velocities[i * 3 + 1] * dt;
            // 空气阻力
            this.velocities[i * 3] *= 0.98;
            this.velocities[i * 3 + 1] *= 0.98;
            // 淡出
            const life = this.ages[i] / this.lifetimes[i];
            this.alphas[i] = (1.0 - life) * 0.9;
            this.sizes[i] *= (1.0 - dt * 0.5); // 收缩
            // 压缩
            if (alive !== i) {
                for (let c = 0; c < 3; c++) {
                    this.positions[alive * 3 + c] = this.positions[i * 3 + c];
                    this.velocities[alive * 3 + c] = this.velocities[i * 3 + c];
                    this.colors[alive * 3 + c] = this.colors[i * 3 + c];
                }
                this.sizes[alive] = this.sizes[i];
                this.alphas[alive] = this.alphas[i];
                this.ages[alive] = this.ages[i];
                this.lifetimes[alive] = this.lifetimes[i];
            }
            alive++;
        }
        this.count = alive;
        for (let i = alive; i < SPLASH_MAX; i++) {
            this.alphas[i] = 0;
        }
        this.mesh.geometry.attributes.position.needsUpdate = true;
        this.mesh.geometry.attributes.aSize.needsUpdate = true;
        this.mesh.geometry.attributes.aAlpha.needsUpdate = true;
        this.mesh.geometry.attributes.aColor.needsUpdate = true;
        this.mesh.geometry.setDrawRange(0, this.count);
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}

// ═══════════════════════════════════════════════════════
// 焦散光影系统 (Caustics)
// ═══════════════════════════════════════════════════════

const CAUSTICS_VERTEX = `
    varying vec2 vUv;
    void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
`;
const CAUSTICS_FRAGMENT = `
    uniform float uTime;
    uniform float uIntensity;
    uniform vec3 uColor;
    varying vec2 vUv;

    float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
    }
    float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float causticPattern(vec2 uv, float time) {
        vec2 p = uv * 4.0;
        float minDist = 1.0;
        for (int y = -1; y <= 1; y++) {
            for (int x = -1; x <= 1; x++) {
                vec2 neighbor = vec2(float(x), float(y));
                vec2 point = vec2(
                    noise(floor(p) + neighbor + vec2(time * 0.1, 0.0)),
                    noise(floor(p) + neighbor + vec2(0.0, time * 0.13))
                );
                point = 0.5 + 0.5 * sin(time * 0.4 + 6.2832 * point);
                float dist = length(fract(p) - neighbor - point);
                minDist = min(minDist, dist);
            }
        }
        return pow(1.0 - minDist, 3.0);
    }

    void main() {
        float c1 = causticPattern(vUv, uTime);
        float c2 = causticPattern(vUv * 1.3 + 0.5, uTime * 0.7 + 10.0);
        float caustic = (c1 + c2) * 0.5;
        vec2 center = vUv - 0.5;
        float vignette = 1.0 - smoothstep(0.35, 0.55, length(center));
        float alpha = caustic * uIntensity * vignette;
        // 增强对比度：让亮部更亮
        alpha = pow(alpha, 0.7);
        gl_FragColor = vec4(uColor * 1.2, alpha);
    }
`;

export class CausticsEffect {
    constructor(scene, opts = {}) {
        const { width = 300, height = 200, z = -5 } = opts;
        this.scene = scene;
        this.uniforms = {
            uTime: { value: 0 },
            uIntensity: { value: 0.7 },
            uColor: { value: new THREE.Color(0.6, 0.85, 1.0) },
        };

        const geometry = new THREE.PlaneGeometry(width, height);
        const material = new THREE.ShaderMaterial({
            vertexShader: CAUSTICS_VERTEX,
            fragmentShader: CAUSTICS_FRAGMENT,
            uniforms: this.uniforms,
            transparent: true,
            depthWrite: false,
            blending: THREE.AdditiveBlending,
            side: THREE.DoubleSide,
        });

        this.mesh = new THREE.Mesh(geometry, material);
        this.mesh.position.z = z;
        scene.add(this.mesh);
    }

    update(time) {
        this.uniforms.uTime.value = time;
    }

    setIntensity(val) {
        this.uniforms.uIntensity.value = val;
    }

    dispose() {
        this.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.mesh.material.dispose();
    }
}
