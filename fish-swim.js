/**
 * 鱼游泳动画模块
 * - 身体波浪变形（顶点着色器注入 + CPU 级摇摆后备）
 * - 窜动行为（dart & glide）
 * - 多鱼群（放生阶段 boids）
 */
import * as THREE from 'three';

// ═══════════════════════════════════════════════════════
// 1. 身体游泳动画 - 顶点着色器 + CPU 摇摆
// ═══════════════════════════════════════════════════════

/**
 * 给 GLB 鱼模型注入身体波浪动画
 * 双重保险：顶点着色器变形 + CPU 级子网格旋转摇摆
 */
export function applySwimDeformation(fishGroup, opts = {}) {
    const {
        speed = 4.0,         // 摆尾频率
        amplitude = 0.35,    // 摆尾幅度（大幅度确保可见）
        frequency = 2.0,     // 波长
        tailBias = 2.0,      // 尾部放大系数
    } = opts;

    const swimUniforms = {
        uSwimTime: { value: 0 },
        uSwimSpeed: { value: speed },
        uSwimAmp: { value: amplitude },
        uSwimFreq: { value: frequency },
        uTailBias: { value: tailBias },
    };

    // 收集所有子 mesh 用于 CPU 摇摆
    const meshes = [];
    let boundingBox = null;

    fishGroup.traverse((obj) => {
        if (!obj.isMesh) return;
        meshes.push(obj);
        // 计算整体包围盒
        if (!boundingBox) {
            boundingBox = new THREE.Box3().setFromObject(obj);
        } else {
            boundingBox.expandByObject(obj);
        }

        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        mats.forEach((mat) => {
            mat.onBeforeCompile = (shader) => {
                shader.uniforms.uSwimTime = swimUniforms.uSwimTime;
                shader.uniforms.uSwimSpeed = swimUniforms.uSwimSpeed;
                shader.uniforms.uSwimAmp = swimUniforms.uSwimAmp;
                shader.uniforms.uSwimFreq = swimUniforms.uSwimFreq;
                shader.uniforms.uTailBias = swimUniforms.uTailBias;

                shader.vertexShader = shader.vertexShader.replace(
                    '#include <common>',
                    `#include <common>
                    uniform float uSwimTime;
                    uniform float uSwimSpeed;
                    uniform float uSwimAmp;
                    uniform float uSwimFreq;
                    uniform float uTailBias;
                    `
                );

                shader.vertexShader = shader.vertexShader.replace(
                    '#include <begin_vertex>',
                    `#include <begin_vertex>
                    float bodyPos = clamp(position.z * 0.5 + 0.5, 0.0, 1.0);
                    float tailFactor = pow(bodyPos, uTailBias);
                    float wave = sin(bodyPos * uSwimFreq * 6.2832 - uSwimTime * uSwimSpeed) * uSwimAmp * tailFactor;
                    transformed.x += wave;
                    // 侧面可见的垂直分量（尾鳍上下摆动效果）
                    float vWave = sin(bodyPos * uSwimFreq * 6.2832 - uSwimTime * uSwimSpeed + 1.57) * uSwimAmp * tailFactor * 0.35;
                    transformed.y += vWave;
                    `
                );
            };
            mat.needsUpdate = true;
        });
    });

    // CPU 级摇摆：给整个 group 加一个可见的身体扭动
    // 这是后备方案，确保即使着色器注入失败也有视觉效果
    const bodyLength = boundingBox ? (boundingBox.max.z - boundingBox.min.z) : 1;

    return {
        uniforms: swimUniforms,
        update(time) {
            swimUniforms.uSwimTime.value = time;
            
            // CPU 摇摆已移至 app.js 的 animate 循环中统一处理
            // 不再在此覆盖 rotation.z，避免与侧视朝向冲突
        }
    };
}


// ═══════════════════════════════════════════════════════
// 2. 窜动行为（Dart & Glide）- FISHING 阶段
// ═══════════════════════════════════════════════════════

// 共享临时变量（避免每帧 GC）
const _forward = new THREE.Vector3(0, 0, 1); // 鱼模型鼻子方向 (+Z)
const _qTarget = new THREE.Quaternion();
const _qBank = new THREE.Quaternion();
const _tmpV3 = new THREE.Vector3();
const _desiredDir = new THREE.Vector3();
const _right = new THREE.Vector3();
const _corrUp = new THREE.Vector3();
const _mat4 = new THREE.Matrix4();
const _worldUp = new THREE.Vector3(0, 1, 0);

/**
 * 从 direction 计算鱼的四元数，保证鱼背(+Y)始终朝上、鱼鼻(+Z)指向 direction
 * 避免 setFromUnitVectors 在某些角度产生意外翻滚
 */
function fishQuaternionFromDirection(direction, quaternion) {
    // right = worldUp × direction（鱼的局部X轴）
    _right.crossVectors(_worldUp, direction);
    if (_right.lengthSq() < 0.001) {
        // direction 几乎垂直（极端情况），用 fallback
        _right.set(0, 0, -1);
    }
    _right.normalize();
    // correctedUp = direction × right（鱼的局部Y轴 = 鱼背方向）
    _corrUp.crossVectors(direction, _right).normalize();
    // 构造旋转矩阵：列 = [right, correctedUp, direction]
    _mat4.makeBasis(_right, _corrUp, direction);
    quaternion.setFromRotationMatrix(_mat4);
}

/**
 * 鱼自然游动控制器 - 纯侧影模式
 * 方向强制XY平面（z=0），相机在z轴始终看到侧面
 * 位置可有Z深度变化（近大远小）
 */
export class FishDartController {
    constructor(bounds = { x: 100, y: 60, z: 25 }) {
        this.bounds = bounds;
        this.pos = new THREE.Vector3(
            (Math.random() - 0.5) * bounds.x * 0.5,
            (Math.random() - 0.5) * bounds.y * 0.5,
            (Math.random() - 0.5) * (bounds.z || 25) * 0.3
        );
        this.velocity = new THREE.Vector3();
        this.speed = 55 + Math.random() * 20;
        this.targetSpeed = this.speed;
        
        // direction 强制XY平面（纯侧影）
        const initAngle = Math.random() * Math.PI * 2;
        this.direction = new THREE.Vector3(
            Math.cos(initAngle),
            Math.sin(initAngle) * 0.3,
            0
        ).normalize();
        this.quaternion = new THREE.Quaternion();
        fishQuaternionFromDirection(this.direction, this.quaternion);
        this.prevDir = this.direction.clone();
        
        // 期望方向（XY平面角度）
        this.desiredAngle = initAngle;
        
        // 兼容旧代码
        this.heading = initAngle;
        this.displayHeading = initAngle;
        this.bank = 0;
        
        // 漫游参数
        this.wanderTimer = 0;
        this.wanderInterval = 5.0 + Math.random() * 4.0;
        this.burstTimer = 0;
        this.burstCooldown = 3.0 + Math.random() * 4;
        this.isBursting = false;
        
        // 转向速率（弧度/秒）
        this.turnRate = 0.8;
    }

    update(dt) {
        this.turnRate += (0.8 - this.turnRate) * dt * 1.5;

        // 漫游：XY平面内方向变化
        this.wanderTimer += dt;
        if (this.wanderTimer > this.wanderInterval) {
            this.wanderTimer = 0;
            this.wanderInterval = 5.0 + Math.random() * 4.0;
            this.desiredAngle += (Math.random() - 0.5) * 2.0;
        }

        // burst/glide
        this.burstTimer += dt;
        if (!this.isBursting && this.burstTimer > this.burstCooldown) {
            this.isBursting = true;
            this.targetSpeed = 110 + Math.random() * 50;
            this.burstTimer = 0;
            this.burstCooldown = 3 + Math.random() * 4;
        }
        if (this.isBursting) {
            if (this.burstTimer > 0.5 + Math.random() * 0.4) {
                this.isBursting = false;
                this.targetSpeed = 35 + Math.random() * 25;
            }
        }

        this.speed += (this.targetSpeed - this.speed) * dt * 2.0;

        // 期望方向（XY平面，z=0）
        const yFactor = this._attracting ? 0.8 : 0.4;
        _desiredDir.set(
            Math.cos(this.desiredAngle),
            Math.sin(this.desiredAngle) * yFactor,
            0
        ).normalize();
        this._attracting = false; // 每帧重置，需再次调用attractTo才保持

        // XY边界力（提前转向，越近力越强）
        const margin = 0.35;
        const bx = this.bounds.x, by = this.bounds.y;
        if (Math.abs(this.pos.x) > bx * margin) {
            const t = (Math.abs(this.pos.x) - bx * margin) / (bx * (1 - margin));
            _desiredDir.x -= Math.sign(this.pos.x) * t * t * 8;
        }
        if (Math.abs(this.pos.y) > by * margin) {
            const t = (Math.abs(this.pos.y) - by * margin) / (by * (1 - margin));
            _desiredDir.y -= Math.sign(this.pos.y) * t * t * 8;
        }
        _desiredDir.z = 0;
        _desiredDir.normalize();

        // 限速转向
        const cosAngle = THREE.MathUtils.clamp(this.direction.dot(_desiredDir), -1, 1);
        const angle = Math.acos(cosAngle);
        if (angle > 0.001) {
            const maxTurn = this.turnRate * dt;
            const t = Math.min(maxTurn / angle, 1.0);
            this.direction.lerp(_desiredDir, t).normalize();
        }
        this.direction.z = 0;
        this.direction.normalize();

        // XY移动
        this.velocity.copy(this.direction).multiplyScalar(this.speed * dt);
        this.pos.add(this.velocity);

        // Z缓慢随机漂移
        const bz = this.bounds.z || 25;
        this.pos.z += (Math.random() - 0.5) * dt * 3;

        // 边界反弹：撞墙立即掉头（避免后退/卡住）
        if (Math.abs(this.pos.x) >= bx && Math.sign(this.pos.x) === Math.sign(this.direction.x)) {
            this.direction.x *= -1;
            this.desiredAngle = Math.atan2(this.direction.y, this.direction.x);
        }
        if (Math.abs(this.pos.y) >= by && Math.sign(this.pos.y) === Math.sign(this.direction.y)) {
            this.direction.y *= -1;
            this.desiredAngle = Math.atan2(this.direction.y, this.direction.x);
        }
        this.direction.normalize();

        this.pos.x = THREE.MathUtils.clamp(this.pos.x, -bx, bx);
        this.pos.y = THREE.MathUtils.clamp(this.pos.y, -by, by);
        this.pos.z = THREE.MathUtils.clamp(this.pos.z, -bz, bz);

        // 四元数（纯侧影）
        fishQuaternionFromDirection(this.direction, this.quaternion);
        this.prevDir.copy(this.direction);

        this.heading = Math.atan2(this.direction.y, this.direction.x);
        this.displayHeading = this.heading;
        this.bank = 0;
    }

    /** 被手势吸引（XY平面） */
    attractTo(handX, handY) {
        const dx = handX - this.pos.x;
        const dy = handY - this.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        this.desiredAngle = Math.atan2(dy, dx);
        // 靠近时减速（避免绕行轨道）
        this.targetSpeed = dist < 40 ? 20 + dist * 0.5 : 45;
        // 靠近时加快转向
        this.turnRate = dist < 40 ? 2.5 : 1.2;
        this._attracting = true;
    }
}


// ═══════════════════════════════════════════════════════
// 3. 多鱼群 - 放生阶段 Boids（纯侧影）
// ═══════════════════════════════════════════════════════

/**
 * 鱼群系统 - 纯侧影模式
 * direction 强制XY平面，位置可有Z深度
 */
export class FishSchool {
    constructor(templates, count = 8, bounds = { x: 120, y: 80, z: 30 }) {
        this.count = count;
        this.bounds = { x: bounds.x || 120, y: bounds.y || 80, z: bounds.z || 30 };
        this.container = new THREE.Group();
        this.fishes = [];
        
        const templateArr = Array.isArray(templates) ? templates : [templates];

        for (let i = 0; i < count; i++) {
            const template = templateArr[i % templateArr.length];
            const clone = template.clone(true);
            clone.scale.copy(template.scale);
            const sizeFactor = 0.20 + Math.random() * 0.10;
            clone.scale.multiplyScalar(sizeFactor);
            clone.visible = true;

            const angle = Math.random() * Math.PI * 2;
            const speed = 35 + Math.random() * 25;
            const dir = new THREE.Vector3(
                Math.cos(angle),
                Math.sin(angle) * 0.3,
                0
            ).normalize();

            const fish = {
                mesh: clone,
                pos: new THREE.Vector3(
                    (Math.random() - 0.5) * this.bounds.x * 0.6,
                    (Math.random() - 0.5) * this.bounds.y * 0.6,
                    (Math.random() - 0.5) * this.bounds.z * 0.6
                ),
                direction: dir.clone(),
                speed: speed,
                targetSpeed: speed,
                swimPhase: Math.random() * Math.PI * 2,
                swimSpeed: 3.0 + Math.random() * 2.0,
                quaternion: new THREE.Quaternion(),
                prevDir: dir.clone(),
                bankAngle: 0,
                turnRate: 0.5 + Math.random() * 0.3,
            };

            fishQuaternionFromDirection(dir, fish.quaternion);
            clone.quaternion.copy(fish.quaternion);

            this.fishes.push(fish);
            this.container.add(clone);
        }
    }

    update(dt, time, handPos = null) {
        const SEP_DIST = 30;
        const ALIGN_DIST = 70;
        const COHESION_DIST = 100;

        for (let i = 0; i < this.count; i++) {
            const fish = this.fishes[i];

            // Boids 力
            const sep = new THREE.Vector3();
            const align = new THREE.Vector3();
            const cohesion = new THREE.Vector3();
            let sepCount = 0, alignCount = 0, cohesionCount = 0;

            for (let j = 0; j < this.count; j++) {
                if (i === j) continue;
                const other = this.fishes[j];
                const dist = fish.pos.distanceTo(other.pos);
                if (dist < SEP_DIST && dist > 0.1) {
                    _tmpV3.subVectors(fish.pos, other.pos).normalize().divideScalar(dist);
                    sep.add(_tmpV3);
                    sepCount++;
                }
                if (dist < ALIGN_DIST) {
                    align.add(other.direction);
                    alignCount++;
                }
                if (dist < COHESION_DIST) {
                    cohesion.add(other.pos);
                    cohesionCount++;
                }
            }

            _desiredDir.copy(fish.direction);

            if (sepCount > 0) {
                sep.divideScalar(sepCount).normalize();
                _desiredDir.add(sep.multiplyScalar(1.2));
            }
            if (alignCount > 0) {
                align.divideScalar(alignCount).normalize();
                _desiredDir.add(align.multiplyScalar(0.8));
            }
            if (cohesionCount > 0) {
                cohesion.divideScalar(cohesionCount);
                _tmpV3.subVectors(cohesion, fish.pos).normalize();
                _desiredDir.add(_tmpV3.multiplyScalar(0.4));
            }

            // 手势吸引
            if (handPos) {
                _tmpV3.set(handPos.x || 0, handPos.y || 0, 0).sub(fish.pos);
                const handDist = _tmpV3.length();
                if (handDist > 15) {
                    _desiredDir.add(_tmpV3.normalize().multiplyScalar(0.5));
                }
            }

            // XY边界力（提前转向）
            const bx = this.bounds.x, by = this.bounds.y, bz = this.bounds.z;
            const margin = 0.35;
            if (Math.abs(fish.pos.x) > bx * margin) {
                const t = (Math.abs(fish.pos.x) - bx * margin) / (bx * (1 - margin));
                _desiredDir.x -= Math.sign(fish.pos.x) * t * t * 8;
            }
            if (Math.abs(fish.pos.y) > by * margin) {
                const t = (Math.abs(fish.pos.y) - by * margin) / (by * (1 - margin));
                _desiredDir.y -= Math.sign(fish.pos.y) * t * t * 8;
            }

            // 强制XY平面
            _desiredDir.z = 0;
            _desiredDir.normalize();

            // 限速转向
            const cosAngle = THREE.MathUtils.clamp(fish.direction.dot(_desiredDir), -1, 1);
            const angle = Math.acos(cosAngle);
            if (angle > 0.001) {
                const maxTurn = fish.turnRate * dt;
                const t = Math.min(maxTurn / angle, 1.0);
                fish.direction.lerp(_desiredDir, t).normalize();
            }
            fish.direction.z = 0;
            fish.direction.normalize();

            // 速度
            fish.targetSpeed = 40 + Math.sin(time * 0.4 + fish.swimPhase) * 18;
            fish.speed += (fish.targetSpeed - fish.speed) * dt * 2;

            // XY移动
            fish.pos.addScaledVector(fish.direction, fish.speed * dt);

            // Z随机漂移
            fish.pos.z += (Math.random() - 0.5) * dt * 2;

            // 边界反弹：撞墙立即掉头
            if (Math.abs(fish.pos.x) >= bx && Math.sign(fish.pos.x) === Math.sign(fish.direction.x)) {
                fish.direction.x *= -1;
            }
            if (Math.abs(fish.pos.y) >= by && Math.sign(fish.pos.y) === Math.sign(fish.direction.y)) {
                fish.direction.y *= -1;
            }
            fish.direction.normalize();

            // 边界
            fish.pos.x = THREE.MathUtils.clamp(fish.pos.x, -bx, bx);
            fish.pos.y = THREE.MathUtils.clamp(fish.pos.y, -by, by);
            fish.pos.z = THREE.MathUtils.clamp(fish.pos.z, -bz, bz);

            // 四元数（纯侧影）
            fishQuaternionFromDirection(fish.direction, fish.quaternion);
            fish.prevDir.copy(fish.direction);

            // 应用到 mesh
            fish.mesh.position.copy(fish.pos);
            fish.mesh.quaternion.copy(fish.quaternion);

            // 摆尾
            const spdRatio = fish.speed / 70;
            const wiggleAmp = 0.03 + spdRatio * 0.03;
            const wiggle = Math.sin((time + fish.swimPhase) * fish.swimSpeed) * wiggleAmp;
            fish.mesh.rotateY(wiggle);

            // 鱼鳞微光
            const shimmer = spdRatio * 0.15;
            const sparkle = Math.max(0, Math.sin(time * 6 + fish.swimPhase * 10)) * shimmer;
            fish.mesh.traverse((obj) => {
                if (obj.isMesh && obj.material && obj.material.emissive) {
                    obj.material.emissiveIntensity = 0.03 + sparkle * 0.25;
                }
            });
        }
    }

    dispose() {
        if (this.container.parent) this.container.parent.remove(this.container);
        this.fishes = [];
    }
}