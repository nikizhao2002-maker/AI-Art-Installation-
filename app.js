/**
 * 钓一盏鱼灯 - 粒子点云交互系统
 * 核心架构：纹理驱动粒子网格 + 手势控制 + 形态变换 + 鱼群模式
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WaterRipple } from './water-ripple.js';
import { FISH_TYPES, loadAllFishPointClouds, loadGLBMesh } from './glb-pointcloud.js';
import { applyStippleMaterial } from './mesh-stipple.js';
import { applySwimDeformation, FishDartController, FishSchool } from './fish-swim.js';
import { BubbleSystem, SplashSystem, CausticsEffect } from './water-effects.js';

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════
const CONFIG = {
    particleGrid: 256,        // 256×256 = 65536 粒子（备用morph）
    texSize: 256,             // 数据纹理尺寸（须与 particleGrid 一致）
    pointSize: 3.0,
    bgColor: 0x080810,
    cameraZ: 160,
    morphDuration: 4.0,       // 形态切换秒数（TD风格需要足够时间展示粒子飞散）
    boidsCount: 600,          // 鱼群数量
    finalModelUrl: 'assets/models/浮金鱼影tripo.glb',
};

const DEFAULTS = {
    pointSize: 5.0,
    relief: 0.0,
    fluidStrength: 0.0,
    breathAmp: 0.02,
    threshold: 0.12,
    tintColor: '#ffffff',
    tintStrength: 0.0,
    waterTheme: 'blue',
    ritualTimeouts: [15, 15, 18, 18, 15],
};
const SFX_GAIN = 0.18;

// 形态阶段（鱼影 → 鱼灯，中间过程暂时忽略）
const STAGES = [
    { name: '鱼影', key: 'fish' },
    { name: '鱼灯', key: 'lantern' },
];

// ═══════════════════════════════════════════════════════
// Shader 代码
// ═══════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════
// 2D 图像粒子网格 Shader（参考 CULTURAL HERITAGE 方案）
// GLB → 渲染为2D图像 → 图像驱动粒子网格
// ═══════════════════════════════════════════════════════
const vertexShader = /* glsl */`
    uniform float uTime;
    uniform float uSize;
    uniform float uMorph;         // 0~1 变形进度
    uniform float uBreathAmp;
    uniform float uFluidStrength; // 流动扰动
    uniform float uScatter;       // 手势散开力度 0~1
    uniform vec3 uHandWorld;
    uniform float uWind;          // 吹气风力 0~1
    uniform sampler2D uPosA;      // 形态A 位置纹理 (RGBA Float)
    uniform sampler2D uPosB;      // 形态B 位置纹理
    uniform sampler2D uColA;      // 形态A 颜色纹理
    uniform sampler2D uColB;      // 形态B 颜色纹理
    uniform vec3 uTintColor;
    uniform float uTintStrength;

    attribute vec2 aUv;           // 数据纹理采样坐标

    varying vec3 vColor;
    varying float vLuma;

    void main() {
        // 从数据纹理采样 3D 位置
        vec3 posA = texture2D(uPosA, aUv).xyz;
        vec3 posB = texture2D(uPosB, aUv).xyz;
        vec3 pos = mix(posA, posB, uMorph);

        // 从数据纹理采样颜色
        vec3 colA = texture2D(uColA, aUv).rgb;
        vec3 colB = texture2D(uColB, aUv).rgb;
        vColor = mix(colA, colB, uMorph);

        // 计算亮度
        vLuma = dot(vColor, vec3(0.299, 0.587, 0.114));

        // 染色叠加
        if (uTintStrength > 0.01) {
            vColor = mix(vColor, vColor * uTintColor, uTintStrength * 0.6);
        }

        // ═══ 游动动画 ═══
        // 用粒子在模型上的归一化 X 位置作为尾部因子
        float normX = (pos.x + 45.0) / 90.0; // 假设模型宽度约90
        float tailFactor = smoothstep(-0.2, 0.6, normX);
        
        // 身体 S 形传播波（从头到尾递增）
        float bodyWave = sin(normX * 8.0 - uTime * 4.0) * tailFactor * 3.5;
        pos.y += bodyWave;
        
        // 尾部额外大幅摆动
        float tailExtra = smoothstep(0.6, 1.0, normX);
        pos.y += sin(uTime * 5.0 - normX * 3.0) * tailExtra * 5.0;
        
        // 胸鳍区域微振（身体中部）
        float finArea = smoothstep(0.2, 0.4, normX) * smoothstep(0.6, 0.4, normX);
        float finWave = sin(uTime * 8.0) * finArea * 2.0;
        pos.z += finWave;
        
        // 整体上下浮动
        pos.y += sin(uTime * 1.0) * 2.0;
        // 轻微左右游动
        pos.x += sin(uTime * 0.7) * 1.2;

        // 呼吸动画（微弱缩放）
        float breath = 1.0 + sin(uTime * 2.0) * uBreathAmp;
        pos *= breath;

        // 流动扰动
        if (uFluidStrength > 0.01) {
            float noise = sin(pos.y * 0.08 + uTime * 1.5) * cos(pos.x * 0.08 + uTime);
            pos.x += noise * uFluidStrength * (1.0 - vLuma);
            pos.y += noise * uFluidStrength * 0.5;
        }

        // ═══ TD 风格形态转换特效 ═══
        // morphScatter: 0→1→0 (中间最大散开)
        float morphScatter = sin(uMorph * 3.14159);
        float morphScatter2 = morphScatter * morphScatter; // 更强的中间爆发
        float rnd = fract(sin(dot(aUv, vec2(12.9898, 78.233))) * 43758.5453);
        float rnd2 = fract(sin(dot(aUv * 2.3, vec2(53.1, 97.3))) * 2847.3);
        float rnd3 = fract(sin(dot(aUv * 7.1, vec2(21.7, 43.1))) * 6271.9);

        // 爆发飞散（粒子从原位置向外飞散，大幅度）
        vec3 flyDir = normalize(pos + vec3(rnd - 0.5, rnd2 - 0.5, rnd3 - 0.5) * 2.0);
        float flyDist = morphScatter2 * (25.0 + rnd * 55.0);
        pos += flyDir * flyDist;

        // 漩涡旋转（绕中心螺旋运动，TD标志性效果）
        float spiralAngle = uTime * 2.5 + rnd * 6.2832 + morphScatter * rnd2 * 8.0;
        float spiralRadius = morphScatter * (4.0 + rnd3 * 12.0);
        pos.x += cos(spiralAngle) * spiralRadius;
        pos.z += sin(spiralAngle) * spiralRadius;
        pos.y += sin(uTime * 1.8 + rnd * 6.2832) * morphScatter * 6.0;

        // curl noise 湍流（有机流动感）
        float noiseT = uTime * 1.2 + rnd * 8.0;
        pos.x += sin(pos.y * 0.06 + noiseT) * morphScatter * 8.0;
        pos.y += cos(pos.x * 0.06 + noiseT * 0.7) * morphScatter * 5.0;
        pos.z += sin(pos.z * 0.04 + noiseT * 0.5) * morphScatter * 4.0;

        // 手势散开
        if (uScatter > 0.01) {
            float d = length(pos);
            if (d > 0.1) {
                vec3 dir = normalize(pos);
                float rnd2 = fract(sin(dot(aUv * 3.7, vec2(53.1, 97.3))) * 2847.3);
                float push = uScatter * (35.0 + rnd2 * 25.0);
                pos += dir * push;
                pos.z += (rnd2 - 0.5) * uScatter * 30.0;
            }
        }

        // 吹气风力
        if (uWind > 0.01) {
            float windRnd = fract(sin(dot(aUv + uTime * 0.1, vec2(37.1, 81.7))) * 4375.5);
            pos.x += uWind * (20.0 + windRnd * 30.0);
            pos.y += uWind * (windRnd - 0.5) * 15.0;
            pos.z += uWind * (windRnd - 0.3) * 8.0;
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        // 变形时粒子放大3倍（更醒目的TD粒子效果）
        float morphSizeMul = 1.0 + morphScatter * 2.5;
        gl_PointSize = uSize * morphSizeMul * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = /* glsl */`
    uniform vec3 uTintColor;
    uniform float uTintStrength;
    uniform float uThreshold;
    uniform float uMorph;

    varying vec3 vColor;
    varying float vLuma;

    void main() {
        // 亮度过低（黑色/极暗）丢弃
        if (vLuma < 0.08) discard;
        // 亮度过高（接近白色/背景）降透明度
        float highLumaFade = 1.0 - smoothstep(uThreshold - 0.15, uThreshold, vLuma);

        // 圆形粒子遮罩
        vec2 coord = gl_PointCoord - vec2(0.5);
        float r2 = dot(coord, coord);
        if (r2 > 0.25) discard;

        // 边缘柔化（中心亮，边缘渐暗）
        float edgeFade = 1.0 - smoothstep(0.3, 0.5, sqrt(r2));

        vec3 rgb = vColor;

        // 色彩增强：提亮 + 饱和度提升
        rgb = pow(rgb, vec3(0.75)); // 反 gamma 提亮
        rgb *= 1.2; // 整体提亮

        // 金色高光增强
        vec3 gold = vec3(0.85, 0.65, 0.2);
        rgb = mix(rgb, gold, vLuma * 0.12);

        // 染色叠加
        if (uTintStrength > 0.01) {
            rgb = mix(rgb, rgb * uTintColor, uTintStrength * 0.6);
        }

        // TD 风格变形发光：转变中粒子发出温暖光芒（高亮度）
        float morphGlow = sin(uMorph * 3.14159);
        vec3 glowColor = mix(vec3(0.4, 0.7, 1.0), vec3(1.0, 0.8, 0.3), uMorph); // 蓝→金渐变
        rgb = mix(rgb, glowColor, morphGlow * 0.7); // 更强的颜色覆盖
        rgb += glowColor * morphGlow * 0.8; // 叠加发光
        // 变形期间大幅增加透明度（粒子更亮更实）
        float morphAlphaBoost = morphGlow * 0.6;

        // NormalBlending 高alpha，使粒子重叠形成实心表面
        float finalAlpha = edgeFade * 0.88 * highLumaFade + morphAlphaBoost;
        finalAlpha = clamp(finalAlpha, 0.0, 1.0);
        gl_FragColor = vec4(rgb, finalAlpha);
    }
`;

// ═══════════════════════════════════════════════════════
// 全局变量
// ═══════════════════════════════════════════════════════
let scene, camera, renderer, controls, particleSystem, uniforms;
let finalModel = null;
let finalModelMixer = null;
let isFinalModelVisible = false;
let boidsGroup;
let waterRipple;
let clock = new THREE.Clock();
let currentStage = 0;
let isMorphing = false;
let morphProgress = 0;
let isBoidsMode = false;
let textures = [];

// 变形暗化遮罩
const morphOverlay = document.createElement('div');
morphOverlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.6);pointer-events:none;opacity:0;transition:opacity 0.5s;z-index:5;';
document.body.appendChild(morphOverlay);

// GLB 点云数据
let fishPointClouds = [];     // [{fish:{posTex,colTex}, lantern:{posTex,colTex}}, ...]
let currentFishIndex = 0;     // 当前鱼种索引
let pcTextures = { posA: null, posB: null, colA: null, colB: null };
// GLB 渲染为 2D 纹理（CRAFTING 阶段粒子系统用）
let fishRenderedTextures = { fish: null, lantern: null };
// GLB 网格模型（FISHING 阶段直接显示）
let fishMeshGroup = null;     // 当前显示的鱼网格 THREE.Group
let fishStippleMat = null;    // 粒子化材质引用
let fishMeshSwimTime = 0;     // 游动动画时间
let fishSwimCtrl = null;      // 游泳变形控制器 { update(time), uniforms }
let fishDartCtrl = null;      // 窜动行为控制器 FishDartController
let fishSchool = null;        // 放生阶段鱼群 FishSchool
let fishingLine = null;       // 钓鱼线+鱼钩 Three.js 对象
let lanternMeshGroup = null;  // 鱼灯 GLB 模型
let allFishMeshes = [];       // 全部5种鱼的GLB（用于鱼群混合）
let bubbleSystem = null;      // 气泡特效
let splashSystem = null;      // 水花特效
let causticsEffect = null;    // 焦散光影
let handData = { detected: false, palmX: 0, palmY: 0, pinchDist: 1.0, isPinching: false, pinchCooldown: 0, fingersUp: 0 };
let sfxContext = null;
let sfxMaster = null;
// 旧版水平切换手势状态（保留占位，主流程已改为仪式手势）
let swipeState = { lastPalmX: 0, swipeAccum: 0, swipeCooldown: 0 };
// 张手/握拳散聚状态
let scatterStrength = 0; // 0=聚拢, 1=最大散开
let openPalmHoldTime = 0; // 张手保持时间（需>0.5s才触发散开）

// ── 制灯/放生 仪式手势状态机 ──────────────────────────────
// 每个手势有独立的积累计数器 + 冷却，防止误触
const RITUAL_COOLDOWN = 90; // 手势触发后冷却帧数（约1.5s@60fps）
let ritualCooldown = 0;     // 全局冷却（触发任意手势后锁定）

// 手势1：双手向两侧推开 → 活鱼→骨架（stage 0→1）
// 检测：同时检测到两只手，且两手腕X距离持续扩大
let spreadGesture = { prevDist: 0, accumDelta: 0 };

// 手势2：单手从左到右缓慢抹过 → 骨架→糊纸（stage 1→2）
// 检测：手腕X从负到正持续移动，速度慢（仪式感）
let wipeGesture = { startX: null, traveling: false, accumX: 0 };

// 手势3：握拳→张开 → 糊纸→上色（stage 2→3）
// 检测：fingersUp从≤1升到≥4
let bloomGesture = { wasFist: false, holdFistTime: 0 };

// 手势4：双手靠近→向上托起 → 上色→鱼灯（stage 3→4）
// 检测：两手腕距离接近（<0.28）且双手整体上移
let liftGesture = { wasClose: false, closeTime: 0, startY: null, riseAccum: 0 };

// 放生手势：张开五指向前推→手腕持续上移 → 放生完成
// 检测：fingersUp=5 保持 + palmY持续减小（上移）
let releaseGesture = { openTime: 0, startY: null, riseAccum: 0 };

function getSfxContext() {
    if (!sfxContext) sfxContext = new (window.AudioContext || window.webkitAudioContext)();
    if (!sfxMaster) {
        sfxMaster = sfxContext.createGain();
        sfxMaster.gain.value = 0.35;
        sfxMaster.connect(sfxContext.destination);
    }
    if (sfxContext.state === 'suspended') sfxContext.resume();
    return sfxContext;
}

function playTone({
    freqs,
    type = 'sine',
    duration = 0.4,
    attack = 0.01,
    decay = 0.18,
    sustain = 0.2,
    release = 0.3,
    gain = 0.18,
    filterHz = null,
    noise = 0.0,
    detune = 0
} = {}) {
    try {
        const ctx = getSfxContext();
        const now = ctx.currentTime;
        const env = ctx.createGain();
        const targetGain = SFX_GAIN;
        env.gain.setValueAtTime(0.0001, now);
        env.gain.linearRampToValueAtTime(targetGain, now + attack);
        env.gain.linearRampToValueAtTime(targetGain * sustain, now + attack + decay);
        env.gain.exponentialRampToValueAtTime(0.0001, now + duration + release);

        let out = env;
        if (filterHz) {
            const lp = ctx.createBiquadFilter();
            lp.type = 'lowpass';
            lp.frequency.value = filterHz;
            env.connect(lp);
            out = lp;
        }
        out.connect(sfxMaster);

        const frequencyList = Array.isArray(freqs) ? freqs : [freqs];
        frequencyList.forEach((f) => {
            const osc = ctx.createOscillator();
            osc.type = type;
            osc.frequency.value = f;
            osc.detune.value = detune;
            osc.connect(env);
            osc.start(now);
            osc.stop(now + duration + release + 0.05);
        });

        if (noise > 0) {
            const buffer = ctx.createBuffer(1, ctx.sampleRate * (duration + release), ctx.sampleRate);
            const data = buffer.getChannelData(0);
            for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * noise;
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.connect(env);
            src.start(now);
            src.stop(now + duration + release + 0.05);
        }
    } catch (e) {
        // Audio not available or blocked; ignore.
    }
}

function playPhaseSfx(phase) {
    switch (phase) {
        case PHASES.WATER:
            // Water droplet + soft shimmer
            playTone({ freqs: [660, 990], type: 'sine', duration: 0.18, attack: 0.005, decay: 0.06, sustain: 0.2, release: 0.12, gain: 0.14, filterHz: 1400, noise: 0.08 });
            break;
        case PHASES.FISHING:
            // Bamboo chime
            playTone({ freqs: [523.25, 783.99], type: 'triangle', duration: 0.35, attack: 0.01, decay: 0.12, sustain: 0.25, release: 0.25, gain: 0.2, filterHz: 1800 });
            break;
        case PHASES.CRAFTING:
            // Guqin pluck
            playTone({ freqs: 392.0, type: 'triangle', duration: 0.45, attack: 0.008, decay: 0.14, sustain: 0.2, release: 0.35, gain: 0.22, filterHz: 1200 });
            break;
        case PHASES.RELEASE:
            // Bell-like release
            playTone({ freqs: [659.25, 1318.5], type: 'sine', duration: 0.6, attack: 0.01, decay: 0.2, sustain: 0.2, release: 0.6, gain: 0.25, filterHz: 2200 });
            break;
        default:
            break;
    }
}

function playRitualSfx(stage) {
    switch (stage) {
        case 1:
            // Spread frame: woody knock
            playTone({ freqs: 220.0, type: 'triangle', duration: 0.22, attack: 0.005, decay: 0.08, sustain: 0.2, release: 0.18, gain: 0.2, filterHz: 900, noise: 0.04 });
            break;
        case 2:
            // Wipe: brush swish
            playTone({ freqs: 330.0, type: 'sine', duration: 0.25, attack: 0.01, decay: 0.08, sustain: 0.1, release: 0.18, gain: 0.12, filterHz: 1400, noise: 0.22 });
            break;
        case 3:
            // Bloom: ink shimmer
            playTone({ freqs: [523.25, 659.25], type: 'sine', duration: 0.3, attack: 0.01, decay: 0.1, sustain: 0.2, release: 0.25, gain: 0.18, filterHz: 2000 });
            break;
        case 4:
            // Lift: lantern ignition
            playTone({ freqs: [440.0, 880.0], type: 'triangle', duration: 0.4, attack: 0.01, decay: 0.12, sustain: 0.2, release: 0.35, gain: 0.22, filterHz: 1700 });
            break;
        case 'release':
            // Release: airy drift
            playTone({ freqs: 330.0, type: 'sine', duration: 0.45, attack: 0.02, decay: 0.12, sustain: 0.2, release: 0.35, gain: 0.16, filterHz: 1800, noise: 0.18 });
            break;
        default:
            break;
    }
}

// 手势提示文字映射
const GESTURE_HINTS = {
    0: '双手张开向两侧推 · 制作鱼灯',
    1: '鱼灯完成 · 张手向上放生',
};
const RITUAL_CUES = {
    water: {
        gesture: 'release',
        kicker: '入场',
        title: '伸手触碰水面',
        subtitle: '用指尖制造水波，停留片刻或捏合进入钓鱼。',
    },
    fishing: {
        gesture: 'wipe',
        kicker: '钓鱼',
        title: '慢慢靠近鱼影',
        subtitle: '手掌引鱼靠近，鱼浮起后捏合抓住它。',
    },
    0: {
        gesture: 'spread',
        kicker: '制灯 1/2',
        title: '双手向两侧推开',
        subtitle: '将活鱼化为鱼灯，粒子会重新聚合成灯的形态。',
    },
    1: {
        gesture: 'release',
        kicker: '完成',
        title: '张开手掌向上抬',
        subtitle: '把鱼灯送回水面，完成放生。',
    },
};
// 麦克风/吹气检测
let micAnalyser = null;
let micDataArray = null;
let blowStrength = 0; // 0~1 吹气强度

// 页面阶段状态机
const PHASES = {
    WATER: 'water',       // 水面阶段：只有水波纹
    FISHING: 'fishing',   // 钓鱼阶段：鱼跃出水面
    CRAFTING: 'crafting', // 制灯阶段：形态切换
    RELEASE: 'release',   // 放生阶段：鱼群
};
let currentPhase = PHASES.WATER;
let phaseTransitioning = false;
let RITUAL_TIMEOUTS = [...DEFAULTS.ritualTimeouts];
let ritualTimeoutTimer = 0;

function resetRitualTimeout() {
    ritualTimeoutTimer = 0;
}

// ═══════════════════════════════════════════════════════
// 初始化
// ═══════════════════════════════════════════════════════
async function init() {
    // 场景
    scene = new THREE.Scene();
    // 不设置 scene.background - 让水波纹背景透出来
    scene.fog = new THREE.FogExp2(0x080810, 0.001);
    scene.add(new THREE.HemisphereLight(0xd8ecff, 0x2a1508, 1.6));
    const finalKeyLight = new THREE.DirectionalLight(0xffdf9a, 2.8);
    finalKeyLight.position.set(120, 150, 120);
    scene.add(finalKeyLight);
    const finalRimLight = new THREE.DirectionalLight(0x82d9ff, 1.8);
    finalRimLight.position.set(-140, 80, -120);
    scene.add(finalRimLight);

    // 相机
    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, CONFIG.cameraZ);

    // 渲染器
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0); // 透明背景
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    document.getElementById('canvas-container').appendChild(renderer.domElement);

    // 水下特效系统
    bubbleSystem = new BubbleSystem(scene);
    splashSystem = new SplashSystem(scene);
    causticsEffect = new CausticsEffect(scene, { width: 350, height: 220, z: -8 });

    // 轨道控制（鼠标兜底操作）
    controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.05;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.3;
    controls.enablePan = false;
    controls.minDistance = 50;
    controls.maxDistance = 300;

    // 加载纹理
    await loadTextures();

    // 创建粒子系统
    createParticleSystem();

    // 创建鱼群（隐藏状态）
    createBoids();

    // 加载终局 3D 鱼模型（隐藏状态）
    loadFinalModel();

    // 添加水波纹背景粒子
    createBackgroundParticles();

    // 设置 UI 交互
    setupUI();

    // 设置手势识别
    setupMediaPipe();

    // 设置麦克风（吹气检测）
    setupMicrophone();

    // 设置手机连接（PeerJS + QR码）
    setupPeerConnection();

    // 监听窗口
    window.addEventListener('resize', onResize);
    window.addEventListener('keydown', onKeyDown);

    // 隐藏加载页
    setTimeout(() => {
        const loader = document.getElementById('loader');
        loader.classList.add('hidden');
        setTimeout(() => loader.remove(), 1000); // 过渡完成后彻底移除
    }, 800);

    // 初始化阶段：从水面开始
    enterPhase(PHASES.WATER);

    // 渲染循环
    animate();
}

// ═══════════════════════════════════════════════════════
// 纹理加载
// ═══════════════════════════════════════════════════════
async function loadTextures() {
    // 加载所有鱼种的 GLB 点云数据
    const loaderSub = document.querySelector('.loader-sub');
    fishPointClouds = await loadAllFishPointClouds(CONFIG.texSize, 90, (loaded, total) => {
        console.log(`[INFO] 点云采样: ${FISH_TYPES[loaded - 1].name} (${loaded}/${total})`);
        if (loaderSub) loaderSub.textContent = `正在采样点云... ${loaded}/${total}`;
    });
    // 设置初始鱼种的纹理
    applyFishTextures(currentFishIndex, 0);
    console.log(`[INFO] 全部点云加载完成, ${FISH_TYPES.length} 种鱼, 每种 ${CONFIG.texSize * CONFIG.texSize} 粒子`);

    // 加载当前鱼种的 GLB 网格模型（FISHING 阶段直接渲染用）
    if (loaderSub) loaderSub.textContent = '正在加载3D模型...';
    await loadFishMesh(currentFishIndex);
    await loadLanternMesh(currentFishIndex);
    
    // 预加载全部5种鱼的GLB（用于鱼群阶段混合显示）
    if (loaderSub) loaderSub.textContent = '正在加载鱼群模型...';
    allFishMeshes = [];
    // 浮金鱼(0)和红鲤鱼(3)的模型鼻子方向与其他鱼相反，需翻转几何体
    const NOSE_FLIPPED = [0, 3];
    const flipMatrix = new THREE.Matrix4().makeRotationY(Math.PI);
    for (let i = 0; i < FISH_TYPES.length; i++) {
        try {
            const mesh = await loadGLBMesh(FISH_TYPES[i].fish, 90);
            mesh.visible = false;
            if (NOSE_FLIPPED.includes(i)) {
                mesh.traverse(child => {
                    if (child.isMesh && child.geometry) {
                        child.geometry.applyMatrix4(flipMatrix);
                    }
                });
            }
            allFishMeshes.push(mesh);
        } catch (e) {
            console.warn(`[WARN] 鱼群模型 ${FISH_TYPES[i].name} 加载失败`);
        }
    }
    console.log(`[INFO] 鱼群模型全部加载: ${allFishMeshes.length} 种`);
}

/**
 * 加载指定鱼种的 GLB 网格模型（保留原始材质）
 */
async function loadFishMesh(fishIdx) {
    const fishType = FISH_TYPES[fishIdx];
    if (!fishType) return;
    // 移除旧的网格
    if (fishMeshGroup) {
        scene.remove(fishMeshGroup);
        fishMeshGroup = null;
        fishStippleMat = null;
        fishSwimCtrl = null;
    }
    try {
        fishMeshGroup = await loadGLBMesh(fishType.fish, 90);
        // 浮金鱼(0)和红鲤鱼(3)模型鼻子方向相反，翻转几何体
        if (fishIdx === 0 || fishIdx === 3) {
            const flip = new THREE.Matrix4().makeRotationY(Math.PI);
            fishMeshGroup.traverse(child => {
                if (child.isMesh && child.geometry) {
                    child.geometry.applyMatrix4(flip);
                }
            });
        }
        // 保留原始材质，不应用 stipple
        fishMeshGroup.visible = false; // 初始隐藏
        scene.add(fishMeshGroup);
        // 注入身体波浪游泳动画
        fishSwimCtrl = applySwimDeformation(fishMeshGroup, {
            speed: 3.5,
            amplitude: 0.1,
            frequency: 2.0,
            tailBias: 2.2,
        });
        window.__fishMeshGroup = fishMeshGroup;
        console.log(`[INFO] 鱼网格模型加载完成: ${fishType.name}`);
    } catch (err) {
        console.warn('[WARN] 鱼网格模型加载失败:', err);
    }
}

/**
 * 加载鱼灯 GLB 模型
 */
async function loadLanternMesh(fishIdx) {
    const fishType = FISH_TYPES[fishIdx];
    if (!fishType) return;
    if (lanternMeshGroup) {
        scene.remove(lanternMeshGroup);
        lanternMeshGroup = null;
    }
    try {
        lanternMeshGroup = await loadGLBMesh(fishType.lantern, 90);
        lanternMeshGroup.visible = false;
        scene.add(lanternMeshGroup);
        console.log(`[INFO] 鱼灯模型加载完成: ${fishType.name}`);
    } catch (err) {
        console.warn('[WARN] 鱼灯模型加载失败:', err);
    }
}

/**
 * 应用指定鱼种的点云纹理到 uniforms
 * @param {number} fishIdx - 鱼种索引
 * @param {number} stageIdx - 0=鱼影, 1=鱼灯
 */
function applyFishTextures(fishIdx, stageIdx) {
    const data = fishPointClouds[fishIdx];
    if (!data) return;
    const stageKey = stageIdx === 0 ? 'fish' : 'lantern';
    pcTextures.posA = data[stageKey].posTex;
    pcTextures.posB = data[stageKey].posTex;
    pcTextures.colA = data[stageKey].colTex;
    pcTextures.colB = data[stageKey].colTex;
    if (uniforms) {
        uniforms.uPosA.value = pcTextures.posA;
        uniforms.uPosB.value = pcTextures.posB;
        uniforms.uColA.value = pcTextures.colA;
        uniforms.uColB.value = pcTextures.colB;
        uniforms.uMorph.value = 0.0;
    }
}

/**
 * 切换鱼种（保持当前阶段）
 */
async function switchFishType(newIndex) {
    if (isMorphing) return;
    if (newIndex < 0) newIndex = FISH_TYPES.length - 1;
    if (newIndex >= FISH_TYPES.length) newIndex = 0;
    currentFishIndex = newIndex;
    applyFishTextures(currentFishIndex, currentStage);
    
    // 同时更新网格模型
    await loadFishMesh(currentFishIndex);
    await loadLanternMesh(currentFishIndex);
    
    console.log(`[INFO] 切换鱼种: ${FISH_TYPES[currentFishIndex].name}`);
    // Toast提示
    showToast(`🐟 ${FISH_TYPES[currentFishIndex].name}`);
    // 更新 UI 提示
    const hintEl = document.getElementById('hint-text');
    if (hintEl && currentPhase === PHASES.CRAFTING) {
        hintEl.textContent = `${FISH_TYPES[currentFishIndex].name} · ${STAGES[currentStage].name}`;
    }
}

// ═══════════════════════════════════════════════════════
// 粒子系统（3D 点云 + 数据纹理驱动）
// ═══════════════════════════════════════════════════════
function createParticleSystem() {
    const count = CONFIG.texSize;
    const numParticles = count * count;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(numParticles * 3); // 占位（实际位置由shader从纹理读取）
    const uvs = new Float32Array(numParticles * 2);

    // 生成索引 UV（用于在 shader 中查找数据纹理）
    let idx = 0;
    for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
            const u = (x + 0.5) / count;
            const v = (y + 0.5) / count;

            positions[idx * 3]     = 0;
            positions[idx * 3 + 1] = 0;
            positions[idx * 3 + 2] = 0;

            uvs[idx * 2]     = u;
            uvs[idx * 2 + 1] = v;

            idx++;
        }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));

    // 创建占位纹理（1×1 黑色 Float）
    const placeholderTex = new THREE.DataTexture(
        new Float32Array([0, 0, 0, 1]), 1, 1, THREE.RGBAFormat, THREE.FloatType
    );
    placeholderTex.needsUpdate = true;

    uniforms = {
        uTime:          { value: 0 },
        uPosA:          { value: pcTextures.posA || placeholderTex },
        uPosB:          { value: pcTextures.posB || placeholderTex },
        uColA:          { value: pcTextures.colA || placeholderTex },
        uColB:          { value: pcTextures.colB || placeholderTex },
        uMorph:         { value: 0.0 },
        uSize:          { value: CONFIG.pointSize },
        uBreathAmp:     { value: 0.02 },
        uFluidStrength: { value: 0.0 },
        uScatter:       { value: 0.0 },
        uHandWorld:     { value: new THREE.Vector3(0, 0, 0) },
        uWind:          { value: 0.0 },
        uTintColor:     { value: new THREE.Vector3(1, 1, 1) },
        uTintStrength:  { value: 0.0 },
        uThreshold:     { value: 0.85 },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: true,
        blending: THREE.NormalBlending,
    });

    particleSystem = new THREE.Points(geometry, material);
    particleSystem.frustumCulled = false;
    scene.add(particleSystem);
    // DEBUG
    window.__uniforms = uniforms;
    window.__pcTextures = pcTextures;
    window.__scene = scene;
    window.__particleSystem = particleSystem;
}

// ═══════════════════════════════════════════════════════
// 鱼群 Boids（InstancedMesh 方向感鱼形粒子）
// ═══════════════════════════════════════════════════════
let boidsPositions, boidsVelocities;
let boidsInstancedMesh;
const BOIDS_DUMMY = new THREE.Object3D();

function createBoids() {
    boidsGroup = new THREE.Group();
    boidsGroup.visible = false;
    scene.add(boidsGroup);

    const count = CONFIG.boidsCount;
    boidsPositions = new Float32Array(count * 3);
    boidsVelocities = [];

    for (let i = 0; i < count; i++) {
        boidsPositions[i * 3]     = (Math.random() - 0.5) * 200;
        boidsPositions[i * 3 + 1] = (Math.random() - 0.5) * 150;
        boidsPositions[i * 3 + 2] = (Math.random() - 0.5) * 60;

        boidsVelocities.push(new THREE.Vector3(
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 0.8,
            (Math.random() - 0.5) * 0.4
        ));
    }

    // 鱼形几何：拉长的菱形 + 分叉尾
    const fishShape = new THREE.BufferGeometry();
    const verts = new Float32Array([
        // 身体（菱形）
        -1.2, 0, 0,    // 头
         0.0, 0.35, 0,  // 上
         0.8, 0, 0,     // 尾根
         0.0, -0.35, 0, // 下
        // 尾巴 (V形)
         0.8, 0, 0,     // 尾根
         1.5, 0.4, 0,   // 尾上
         1.2, 0, 0,     // 尾中
         1.5, -0.4, 0,  // 尾下
    ]);
    const indices = [
        0, 1, 2,  0, 2, 3,  // 身体
        4, 5, 6,  4, 6, 7,  // 尾巴
    ];
    fishShape.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    fishShape.setIndex(indices);
    fishShape.computeVertexNormals();

    // InstancedMesh 材质：半透明鱼形
    const fishMat = new THREE.MeshBasicMaterial({
        color: 0xcc8833,
        transparent: true,
        opacity: 0.7,
        side: THREE.DoubleSide,
        blending: THREE.NormalBlending,
        depthWrite: false,
    });

    boidsInstancedMesh = new THREE.InstancedMesh(fishShape, fishMat, count);
    boidsInstancedMesh.frustumCulled = false;

    // 初始化实例颜色（暖金到朱红渐变）
    const color = new THREE.Color();
    for (let i = 0; i < count; i++) {
        const hue = 0.02 + Math.random() * 0.08;
        const sat = 0.75 + Math.random() * 0.25;
        const lum = 0.45 + Math.random() * 0.25;
        color.setHSL(hue, sat, lum);
        boidsInstancedMesh.setColorAt(i, color);
    }
    boidsInstancedMesh.instanceColor.needsUpdate = true;

    boidsGroup.add(boidsInstancedMesh);
}

function updateBoids(target, mode = 'follow') {
    if (!boidsGroup.visible || !boidsPositions || !boidsInstancedMesh) return;

    const count = CONFIG.boidsCount;
    const maxSpeed = mode === 'attract' ? 2.5 : 1.8;
    const maxForce = 0.04;
    const perceptionR = 35;

    for (let i = 0; i < count; i++) {
        const px = boidsPositions[i * 3];
        const py = boidsPositions[i * 3 + 1];
        const pz = boidsPositions[i * 3 + 2];
        const vel = boidsVelocities[i];

        let sepX = 0, sepY = 0, sepZ = 0;
        let aliX = 0, aliY = 0, aliZ = 0;
        let cohX = 0, cohY = 0, cohZ = 0;
        let total = 0;

        for (let j = 0; j < count; j += 3) {
            if (i === j) continue;
            const dx = px - boidsPositions[j * 3];
            const dy = py - boidsPositions[j * 3 + 1];
            const dz = pz - boidsPositions[j * 3 + 2];
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (dist > 0 && dist < perceptionR) {
                sepX += dx / dist; sepY += dy / dist; sepZ += dz / dist;
                aliX += boidsVelocities[j].x; aliY += boidsVelocities[j].y; aliZ += boidsVelocities[j].z;
                cohX += boidsPositions[j * 3]; cohY += boidsPositions[j * 3 + 1]; cohZ += boidsPositions[j * 3 + 2];
                total++;
            }
        }

        let ax = 0, ay = 0, az = 0;

        if (mode === 'scatter') {
            // 张手散开：从手掌位置推开
            const dx = px - target.x, dy = py - target.y, dz = pz - target.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) + 0.1;
            const repel = 8.0 / (dist * 0.1 + 1.0);
            ax += (dx / dist) * repel * 0.01;
            ay += (dy / dist) * repel * 0.01;
            az += (dz / dist) * repel * 0.005;
            // 保留弱分离力
            if (total > 0) {
                sepX /= total; sepY /= total; sepZ /= total;
                ax += sepX * maxForce * 2.0; ay += sepY * maxForce * 2.0; az += sepZ * maxForce * 2.0;
            }
        } else {
            // follow / attract 模式使用正常 boids 规则
            if (total > 0) {
                sepX /= total; sepY /= total; sepZ /= total;
                ax += sepX * maxForce * 3.5; ay += sepY * maxForce * 3.5; az += sepZ * maxForce * 3.5;
                aliX /= total; aliY /= total; aliZ /= total;
                ax += (aliX - vel.x) * maxForce * 1.5; ay += (aliY - vel.y) * maxForce * 1.5; az += (aliZ - vel.z) * maxForce * 1.5;
                cohX /= total; cohY /= total; cohZ /= total;
                ax += (cohX - px) * maxForce * 0.008; ay += (cohY - py) * maxForce * 0.008; az += (cohZ - pz) * maxForce * 0.008;
            }

            // 目标吸引力度
            const attractStrength = mode === 'attract' ? 0.006 : 0.002;
            ax += (target.x - px) * attractStrength;
            ay += (target.y - py) * attractStrength;
            az += (target.z - pz) * attractStrength * 0.5;
        }

        vel.x += ax; vel.y += ay; vel.z += az;
        const speed = vel.length();
        if (speed > maxSpeed) vel.multiplyScalar(maxSpeed / speed);
        // 最低速度（避免静止）
        if (speed < 0.3) vel.multiplyScalar(0.3 / speed);

        boidsPositions[i * 3]     += vel.x;
        boidsPositions[i * 3 + 1] += vel.y;
        boidsPositions[i * 3 + 2] += vel.z;

        // 边界环绕
        if (boidsPositions[i * 3] > 150) boidsPositions[i * 3] = -150;
        if (boidsPositions[i * 3] < -150) boidsPositions[i * 3] = 150;
        if (boidsPositions[i * 3 + 1] > 120) boidsPositions[i * 3 + 1] = -120;
        if (boidsPositions[i * 3 + 1] < -120) boidsPositions[i * 3 + 1] = 120;
        if (boidsPositions[i * 3 + 2] > 50) boidsPositions[i * 3 + 2] = -50;
        if (boidsPositions[i * 3 + 2] < -50) boidsPositions[i * 3 + 2] = 50;

        // 更新 InstancedMesh 矩阵（位置+朝向速度方向+大小随机）
        BOIDS_DUMMY.position.set(
            boidsPositions[i * 3],
            boidsPositions[i * 3 + 1],
            boidsPositions[i * 3 + 2]
        );
        // 朝向速度方向
        const angle = Math.atan2(vel.y, vel.x);
        BOIDS_DUMMY.rotation.set(0, 0, angle);
        // 大小变化 (3~7)
        const s = 3 + (i % 5);
        // 尾巴摆动
        const tailWag = Math.sin(clock.getElapsedTime() * 6 + i * 0.5) * 0.15;
        BOIDS_DUMMY.rotation.z += tailWag;
        BOIDS_DUMMY.scale.set(s, s * 0.7, 1);
        BOIDS_DUMMY.updateMatrix();
        boidsInstancedMesh.setMatrixAt(i, BOIDS_DUMMY.matrix);
    }

    boidsInstancedMesh.instanceMatrix.needsUpdate = true;
}

function loadFinalModel() {
    // 不再加载独立的终局模型，RELEASE 阶段直接复用 fishMeshGroup
    console.log('[INFO] 放生阶段将复用钓鱼阶段的鱼模型');
}

/**
 * 显示鱼灯GLB模型（制灯阶段后期 → 点亮鱼灯时调用）
 */
let lanternGlowProgress = 0;  // 0~1 点亮渐变进度
let lanternGlowing = false;   // 是否正在点亮
let lanternPointLight = null; // 内部点光源

function showLanternModel() {
    if (!lanternMeshGroup) return;
    // 隐藏鱼，显示灯
    if (fishMeshGroup) fishMeshGroup.visible = false;
    lanternMeshGroup.visible = true;
    lanternMeshGroup.position.set(0, 0, 0);
    lanternMeshGroup.rotation.set(0, Math.PI / 2, 0);
    // 保持与鱼相同的展示尺寸
    const origScale = fishMeshGroup ? (fishMeshGroup.userData._originalScale || 1) : 1;
    lanternMeshGroup.scale.setScalar(origScale);
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.8;
    
    // 启动点亮仪式
    lanternGlowing = true;
    lanternGlowProgress = 0;
    // 初始暗色
    lanternMeshGroup.traverse((obj) => {
        if (obj.isMesh && obj.material) {
            obj.material.emissiveIntensity = 0;
        }
    });
    // 添加内部暖光点光源
    if (!lanternPointLight) {
        lanternPointLight = new THREE.PointLight(0xffaa44, 0, 80);
        scene.add(lanternPointLight);
    }
    lanternPointLight.position.set(0, 0, 0);
    lanternPointLight.intensity = 0;
}

function hideLanternModel() {
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
}

function showFinalModel() {
    isFinalModelVisible = true;
    isBoidsMode = false;
    if (particleSystem) particleSystem.visible = false;
    if (boidsGroup) boidsGroup.visible = false;
    // 显示 GLB 模型
    if (fishMeshGroup) {
        fishMeshGroup.visible = true;
        fishMeshGroup.position.set(0, 0, 0);
        fishMeshGroup.rotation.set(0, 0, 0);
    }
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.55;
    controls.target.set(0, 0, 0);
    camera.position.set(0, 18, 170);
    controls.update();

    const cue = document.getElementById('ritual-cue');
    if (cue) cue.classList.add('is-hidden');
}

function hideFinalModel() {
    isFinalModelVisible = false;
    if (fishMeshGroup) fishMeshGroup.visible = false;
    controls.target.set(0, 0, 0);
    controls.autoRotateSpeed = 0.3;
}

// ═══════════════════════════════════════════════════════
// 水波纹背景 + 浮游微光粒子
// ═══════════════════════════════════════════════════════
let rippleMesh, rippleScene, rippleCamera;
function createBackgroundParticles() {
    // 1. 浮游微光粒子（3D 场景内）
    const count = 3000;
    const geo = new THREE.BufferGeometry();
    const pos = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
        pos[i * 3]     = (Math.random() - 0.5) * 500;
        pos[i * 3 + 1] = (Math.random() - 0.5) * 500;
        pos[i * 3 + 2] = (Math.random() - 0.5) * 400;
        sizes[i] = 0.3 + Math.random() * 1.2;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(sizes, 1));

    const mat = new THREE.PointsMaterial({
        size: 0.8,
        color: 0x223355,
        transparent: true,
        opacity: 0.25,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        sizeAttenuation: true,
    });

    const bg = new THREE.Points(geo, mat);
    bg.frustumCulled = false;
    scene.add(bg);

    // 2. 物理水波纹系统（屏幕空间，独立于3D场景）
    waterRipple = new WaterRipple(renderer, camera);
    waterRipple.resize(window.innerWidth, window.innerHeight);
    
    // 创建独立的正交场景用于渲染水波纹全屏背景
    rippleScene = new THREE.Scene();
    rippleCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    
    const rippleGeo = new THREE.PlaneGeometry(2, 2);
    const rippleMat = new THREE.MeshBasicMaterial({
        map: waterRipple.getOutputTexture(),
        depthWrite: false,
        depthTest: false,
    });
    rippleMesh = new THREE.Mesh(rippleGeo, rippleMat);
    rippleScene.add(rippleMesh);
}

// ═══════════════════════════════════════════════════════
// 形态切换
// ═══════════════════════════════════════════════════════
function switchToStage(targetIdx) {
    if (isMorphing) return;
    hideFinalModel();

    // 切入鱼群模式
    if (targetIdx >= STAGES.length) {
        // 进入鱼群前，显示鱼灯GLB模型作为过渡
        showLanternModel();
        enterBoidsMode();
        currentStage = targetIdx;
        updateUI();
        return;
    }

    // 退出鱼群模式
    if (isBoidsMode) {
        exitBoidsMode();
    }

    if (targetIdx === currentStage && !isBoidsMode) return;

    // 设置 morph: 从当前阶段 → 目标阶段
    const data = fishPointClouds[currentFishIndex];
    if (!data) return;
    const fromKey = currentStage === 0 ? 'fish' : 'lantern';
    const toKey = targetIdx === 0 ? 'fish' : 'lantern';

    isMorphing = true;
    morphProgress = 0;
    uniforms.uPosA.value = data[fromKey].posTex;
    uniforms.uPosB.value = data[toKey].posTex;
    uniforms.uColA.value = data[fromKey].colTex;
    uniforms.uColB.value = data[toKey].colTex;
    uniforms.uMorph.value = 0.0;
    currentStage = targetIdx;

    // TD粒子变形：显示粒子系统，隐藏GLB模型（变形期间用粒子表演）
    if (particleSystem) {
        particleSystem.visible = true;
        particleSystem.position.set(0, 0, 0);
    }
    if (fishMeshGroup) fishMeshGroup.visible = false;
    if (lanternMeshGroup) lanternMeshGroup.visible = false;

    // 背景暗化（让粒子更醒目）
    morphOverlay.style.opacity = '1';

    // 提示
    showToast('✨ 粒子化形中…', CONFIG.morphDuration * 1000);

    resetRitualTimeout();
    updateUI();
}

function enterBoidsMode() {
    hideFinalModel();
    isBoidsMode = true;
    particleSystem.visible = false;
    boidsGroup.visible = true;
    // 从制灯阶段自然过渡到放生阶段
    if (currentPhase === PHASES.CRAFTING) {
        currentPhase = PHASES.RELEASE;
        updatePhaseIndicator();
    }
    document.getElementById('hint-text').textContent = GESTURE_HINTS[1] || '张开手掌向上放生';
    updateRitualCue(1);
}

function exitBoidsMode() {
    hideFinalModel();
    isBoidsMode = false;
    particleSystem.visible = true;
    boidsGroup.visible = false;
    // 从放生回到制灯阶段
    if (currentPhase === PHASES.RELEASE) {
        currentPhase = PHASES.CRAFTING;
        updatePhaseIndicator();
    }
    document.getElementById('hint-text').textContent = GESTURE_HINTS[currentStage] || GESTURE_HINTS[0];
    updateRitualCue(currentStage);
}

/**
 * 仪式手势触发：切换到指定stage，或执行放生
 * @param {number|string} target - stage序号(1-4) 或 'release'
 */
function triggerRitualGesture(target) {
    if (target === 'release') {
        playRitualSfx('release');
        resetRitualTimeout();
        ritualCooldown = RITUAL_COOLDOWN;
        // 如果已在放生阶段（鱼群模式），不重复触发
        if (currentPhase === PHASES.RELEASE && fishSchool) return;
        currentPhase = PHASES.RELEASE;
        showFinalModel();
        updateUI();
        updatePhaseIndicator();
        updateGestureProgress(4);
        phaseTransitioning = false;
        const hintEl = document.getElementById('hint-text');
        if (hintEl) hintEl.textContent = '浮金鱼影完成 · 3D 模型已现形';
        updateRitualCue('release', false);
        return;
    }

    // 只允许顺序推进（防止跳跃）
    if (target !== currentStage + 1) return;
    playRitualSfx(target);
    ritualCooldown = RITUAL_COOLDOWN;

    // 视觉反馈：短暂光晕闪烁
    const flash = document.createElement('div');
    flash.style.cssText = `
        position:fixed;inset:0;pointer-events:none;z-index:9999;
        background:radial-gradient(circle, rgba(255,240,200,0.18) 0%, transparent 70%);
        transition: opacity 0.6s ease-out; opacity:1;
    `;
    document.body.appendChild(flash);
    requestAnimationFrame(() => { flash.style.opacity = '0'; });
    setTimeout(() => flash.remove(), 700);

    switchToStage(target);

    const hintEl = document.getElementById('hint-text');
    const stageNames = ['', '骨架已展开', '竹纸已糊上', '色彩已点染', '🏮 鱼灯亮了！'];
    if (hintEl && stageNames[target]) hintEl.textContent = stageNames[target];

    updateGestureProgress(target);
    updateRitualCue(target);
}

function updateGestureProgress(stage) {
    document.querySelectorAll('.gesture-step').forEach((el, i) => {
        el.classList.toggle('done', i <= stage);
    });
}

function updateRitualCue(key, forceShow = true) {
    const cue = RITUAL_CUES[key];
    const root = document.getElementById('ritual-cue');
    if (!root) return;
    // 无对应cue或不强制显示时隐藏
    if (!cue || !forceShow) {
        root.classList.add('is-hidden');
        return;
    }

    const kicker = document.getElementById('ritual-kicker');
    const title = document.getElementById('ritual-title');
    const subtitle = document.getElementById('ritual-subtitle');
    const leftHand = document.querySelector('#ritual-gesture .hand-left');
    const rightHand = document.querySelector('#ritual-gesture .hand-right');
    if (kicker) kicker.textContent = cue.kicker;
    if (title) title.textContent = cue.title;
    if (subtitle) subtitle.textContent = cue.subtitle;
    if (leftHand) leftHand.textContent = cue.hands?.[0] || '✋';
    if (rightHand) rightHand.textContent = cue.hands?.[1] || '✋';
    root.dataset.gesture = cue.gesture;
    root.classList.remove('is-hidden');
}

// ═══════════════════════════════════════════════════════
// 页面阶段管理
// ═══════════════════════════════════════════════════════
let fishShadowTime = 0;
let fishEmergProgress = 0;
let fishShadowOpacity = 0;   // 水下鱼影透明度
let fishAttracted = false;   // 鱼是否被吸引靠近
let fishAttractionTimer = 0; // 鱼影吸引累计时间

// 钓鱼状态机
const FISH_STATE = { SWIMMING: 0, APPROACHING: 1, BITING: 2, STRUGGLING: 3, CAUGHT: 4 };
let fishingState = FISH_STATE.SWIMMING;
let fishingStateTimer = 0;      // 当前状态持续时间
let fishingApproachDelay = 0;   // 自动靠近鱼钩的等待时间
let fishingStruggleCount = 0;   // 挣扎次数计数

function enterPhase(phase) {
    currentPhase = phase;
    phaseTransitioning = true;
    playPhaseSfx(phase);
    if (phase === PHASES.CRAFTING || phase === PHASES.RELEASE) resetRitualTimeout();
    hideFinalModel();
    
    // 统一隐藏所有 GLB，各阶段按需重新显示
    if (fishMeshGroup) fishMeshGroup.visible = false;
    if (lanternMeshGroup) lanternMeshGroup.visible = false;
    if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
    if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
    
    const hintEl = document.getElementById('hint-text');
    const panelBody = document.getElementById('panel-body');
    
    switch (phase) {
        case PHASES.WATER:
            // 水面阶段：隐藏鱼和鱼群，只有水波纹，偶有鱼影
            if (particleSystem) particleSystem.visible = false;
            if (fishMeshGroup) fishMeshGroup.visible = false;
            if (lanternMeshGroup) lanternMeshGroup.visible = false;
            if (boidsGroup) boidsGroup.visible = false;
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
            if (panelBody) panelBody.style.display = 'none';
            if (hintEl) hintEl.textContent = '用指尖触碰水面...';
            updateRitualCue('water');
            controls.autoRotate = false;
            fishShadowOpacity = 0;
            fishAttracted = false;
            fishAttractionTimer = 0;
            { const gp = document.getElementById('gesture-progress'); if (gp) gp.style.display = 'none'; }
            break;
            
        case PHASES.FISHING:
            // 钓鱼阶段：GLB模型侧视游动
            if (particleSystem) particleSystem.visible = false;
            if (lanternMeshGroup) lanternMeshGroup.visible = false;
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            if (fishMeshGroup) {
                fishMeshGroup.visible = true;
                fishMeshGroup.position.set(0, 0, 0);
                // 侧面视角：Y轴-90°让鱼侧面朝相机
                fishMeshGroup.rotation.set(0, -Math.PI / 2, 0);
                // 缩小为水下鱼影（原始90单位太大）
                const baseScale = fishMeshGroup.userData._originalScale || fishMeshGroup.scale.x;
                fishMeshGroup.userData._originalScale = baseScale;
                fishMeshGroup.scale.setScalar(baseScale * 0.35);
            }
            // 创建窜动控制器（缩小范围确保在相机视野内）
            fishDartCtrl = new FishDartController({ x: 55, y: 35 });
            fishMeshSwimTime = 0;
            if (boidsGroup) boidsGroup.visible = false;
            fishEmergProgress = 0;
            fishAttracted = false;
            // 初始化钓鱼状态机
            fishingState = FISH_STATE.SWIMMING;
            fishingStateTimer = 0;
            fishingApproachDelay = 3 + Math.random() * 4; // 3~7秒后鱼开始靠近鱼钩
            fishingStruggleCount = 0;
            // 创建钓鱼线+鱼钩
            createFishingLine();
            if (hintEl) hintEl.textContent = '水下有鱼影在游动...';
            updateRitualCue('fishing');
            controls.autoRotate = false;
            controls.target.set(0, 0, 0);
            // 正面侧视：相机在正前方看鱼的侧面
            camera.position.set(0, 0, 160);
            controls.update();
            break;
            
        case PHASES.CRAFTING:
            // 制灯阶段：GLB模型居中展示（侧面视角）
            if (particleSystem) particleSystem.visible = false;
            // 移除钓鱼线
            if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
            // 清除鱼群（从放生阶段残留）
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            if (fishMeshGroup) {
                fishMeshGroup.visible = true;
                fishMeshGroup.position.set(0, 0, 0);
                // 重置四元数，然后设置侧面朝向（Y=-90°让鼻子朝右）
                fishMeshGroup.quaternion.identity();
                fishMeshGroup.rotation.set(0, -Math.PI / 2, 0);
                // 恢复原始大小
                const origScale = fishMeshGroup.userData._originalScale || fishMeshGroup.scale.x;
                fishMeshGroup.scale.setScalar(origScale);
            }
            if (boidsGroup) boidsGroup.visible = false;
            isBoidsMode = false;
            if (panelBody) panelBody.style.display = '';
            if (hintEl) hintEl.textContent = GESTURE_HINTS[0];
            updateRitualCue(0);
            controls.autoRotate = false; // 不旋转相机（保持水面背景不动）
            controls.autoRotateSpeed = 0;
            // 显示制灯进度指示器
            { const gp = document.getElementById('gesture-progress'); if (gp) gp.style.display = 'flex'; }
            updateGestureProgress(0);
            break;
            
        case PHASES.RELEASE:
            // 放生阶段：一群鱼跟随手势游来游去
            if (particleSystem) particleSystem.visible = false;
            if (fishMeshGroup) fishMeshGroup.visible = false;
            if (lanternMeshGroup) lanternMeshGroup.visible = false;
            if (boidsGroup) boidsGroup.visible = false;
            // 移除钓鱼线
            if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
            // 创建鱼群（5种鱼混合）
            if (fishSchool) { scene.remove(fishSchool.container); fishSchool = null; }
            const templates = allFishMeshes.length > 0 ? allFishMeshes : (fishMeshGroup ? [fishMeshGroup] : []);
            if (templates.length > 0) {
                fishSchool = new FishSchool(templates, 10, { x: 70, y: 50, z: 30 });
                fishSchool.container.visible = true;
                scene.add(fishSchool.container);
            }
            isFinalModelVisible = false; // 放生阶段用鱼群，不显示单条大鱼
            if (panelBody) panelBody.style.display = '';
            if (hintEl) hintEl.textContent = '鱼群跟随你的手游动...伸出手掌引导它们';
            updateRitualCue('release', false);
            controls.autoRotate = false;
            controls.target.set(0, 0, 0);
            // 正面侧视，与钓鱼阶段一致
            camera.position.set(0, 0, 170);
            controls.update();
            break;
    }
    
    updatePhaseIndicator();
    setTimeout(() => { phaseTransitioning = false; }, 500);
}

function updatePhaseIndicator() {
    const phases = [PHASES.WATER, PHASES.FISHING, PHASES.CRAFTING, PHASES.RELEASE];
    const idx = phases.indexOf(currentPhase);
    document.querySelectorAll('.dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === idx);
    });
}

function advancePhase() {
    if (phaseTransitioning) return;
    
    switch (currentPhase) {
        case PHASES.WATER:
            enterPhase(PHASES.FISHING);
            break;
        case PHASES.FISHING:
            enterPhase(PHASES.CRAFTING);
            break;
        case PHASES.CRAFTING:
            enterPhase(PHASES.RELEASE);
            break;
        case PHASES.RELEASE:
            hideFinalModel();
            currentStage = 0;
            applyFishTextures(currentFishIndex, 0);
            enterPhase(PHASES.WATER);
            break;
    }
}

// ═══════════════════════════════════════════════════════
// 手部骨骼绘制（全屏覆盖层）
// ═══════════════════════════════════════════════════════
const HAND_CONNECTIONS = [
    [0,1],[1,2],[2,3],[3,4],       // 拇指
    [0,5],[5,6],[6,7],[7,8],       // 食指
    [0,9],[9,10],[10,11],[11,12],  // 中指
    [0,13],[13,14],[14,15],[15,16],// 无名指
    [0,17],[17,18],[18,19],[19,20],// 小指
    [5,9],[9,13],[13,17],          // 掌横连线
];

function drawHandSkeleton(ctx, landmarks, w, h) {
    // 前置摄像头：镜像翻转X，使右手显示在屏幕右侧（镜像视角）
    const getPos = (lm) => ({
        x: (1.0 - lm.x) * w,
        y: lm.y * h
    });
    
    // 绘制骨骼线（发光效果）
    ctx.shadowColor = 'rgba(100, 220, 255, 0.8)';
    ctx.shadowBlur = 12;
    ctx.strokeStyle = 'rgba(100, 220, 255, 0.6)';
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    
    for (const [a, b] of HAND_CONNECTIONS) {
        const pa = getPos(landmarks[a]);
        const pb = getPos(landmarks[b]);
        ctx.beginPath();
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
        ctx.stroke();
    }
    
    // 绘制关节点
    ctx.shadowBlur = 8;
    for (let i = 0; i < landmarks.length; i++) {
        const p = getPos(landmarks[i]);
        const isFingerTip = [4, 8, 12, 16, 20].includes(i);
        const radius = isFingerTip ? 6 : 3;
        
        // 指尖用亮色大点
        if (isFingerTip) {
            ctx.fillStyle = 'rgba(255, 220, 100, 0.9)';
            ctx.shadowColor = 'rgba(255, 200, 50, 0.8)';
        } else {
            ctx.fillStyle = 'rgba(100, 220, 255, 0.7)';
            ctx.shadowColor = 'rgba(100, 220, 255, 0.5)';
        }
        
        ctx.beginPath();
        ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
        ctx.fill();
    }
    
    ctx.shadowBlur = 0;
}

// ═══════════════════════════════════════════════════════
// MediaPipe 手势
// ═══════════════════════════════════════════════════════
function setupMediaPipe() {
    const video = document.getElementById('camera-video');
    const canvas = document.getElementById('camera-canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = 160;
    canvas.height = 120;

    try {
        console.log('[INFO] MediaPipe Hands 初始化...');
        const hands = new Hands({
            locateFile: (file) => `https://unpkg.com/@mediapipe/hands/${file}`
        });
        hands.setOptions({
            maxNumHands: 2,
            modelComplexity: 1,
            minDetectionConfidence: 0.6,
            minTrackingConfidence: 0.5
        });

        hands.onResults((results) => {
            // 绘制摄像头预览（隐藏的 canvas，仅内部使用）
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(results.image, 0, 0, canvas.width, canvas.height);

            // 获取全屏骨骼画布
            const skelCanvas = document.getElementById('hand-skeleton');
            const skelCtx = skelCanvas.getContext('2d');
            skelCanvas.width = window.innerWidth;
            skelCanvas.height = window.innerHeight;
            skelCtx.clearRect(0, 0, skelCanvas.width, skelCanvas.height);

            if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
                const landmarks = results.multiHandLandmarks[0];
                handData.detected = true;

                // 手掌中心 (wrist)
                handData.palmX = landmarks[0].x - 0.5;  // -0.5~0.5
                handData.palmY = landmarks[0].y - 0.5;

                const allLandmarks = results.multiHandLandmarks;
                const twoHands = allLandmarks.length >= 2;
                const hand0 = allLandmarks[0];
                const hand1 = twoHands ? allLandmarks[1] : null;

                // 手指伸展计数（判断张手/握拳），需先于仪式手势检测更新
                {
                    let fingersUp = 0;
                    // 拇指：指尖x超过指根x（考虑左右手差异，用距手腕的距离判断）
                    const thumbTip = landmarks[4], thumbIP = landmarks[3];
                    const wristX = landmarks[0].x;
                    if (Math.abs(thumbTip.x - wristX) > Math.abs(thumbIP.x - wristX)) fingersUp++;
                    // 其他4指：指尖y < 近指节y（相对手掌方向）
                    if (landmarks[8].y < landmarks[6].y) fingersUp++;   // 食指
                    if (landmarks[12].y < landmarks[10].y) fingersUp++; // 中指
                    if (landmarks[16].y < landmarks[14].y) fingersUp++; // 无名指
                    if (landmarks[20].y < landmarks[18].y) fingersUp++; // 小指
                    handData.fingersUp = fingersUp;
                }

                // ── 仪式手势检测（制灯/放生阶段）────────────────────
                if (ritualCooldown > 0) ritualCooldown--;

                // 更新第二只手骨骼绘制（已在外层处理）

                if (currentPhase === PHASES.CRAFTING && !isMorphing && ritualCooldown === 0) {

                    // ── 手势1：双手向两侧推开 → stage 0→1（活鱼→骨架）──
                    if (currentStage === 0) {
                        if (twoHands) {
                            const x0 = hand0[0].x, x1 = hand1[0].x;
                            const dist = Math.abs(x0 - x1);
                            const delta = dist - spreadGesture.prevDist;
                            if (delta > 0.002) { // 持续扩大
                                spreadGesture.accumDelta += delta;
                            } else {
                                spreadGesture.accumDelta = Math.max(0, spreadGesture.accumDelta - 0.005);
                            }
                            spreadGesture.prevDist = dist;
                            if (spreadGesture.accumDelta > 0.12) {
                                triggerRitualGesture(1);
                                spreadGesture.accumDelta = 0;
                            }
                        } else {
                            spreadGesture.accumDelta = Math.max(0, spreadGesture.accumDelta - 0.01);
                        }
                    }

                    // ── 手势2：单手从左到右缓慢抹过 → stage 1→2（骨架→糊纸）──
                    if (currentStage === 1) {
                        const px = handData.palmX; // -0.5~0.5
                        if (!wipeGesture.traveling && px < -0.2) {
                            // 手在左侧，开始抹
                            wipeGesture.traveling = true;
                            wipeGesture.startX = px;
                            wipeGesture.accumX = 0;
                        }
                        if (wipeGesture.traveling) {
                            const dx = px - (wipeGesture.startX + wipeGesture.accumX);
                            if (dx > 0) wipeGesture.accumX += dx; // 只累计向右的位移
                            if (wipeGesture.accumX > 0.35) {
                                triggerRitualGesture(2);
                                wipeGesture.traveling = false;
                                wipeGesture.accumX = 0;
                                wipeGesture.startX = null;
                            }
                        }
                        // 手移回左侧重置
                        if (px < -0.25) {
                            wipeGesture.traveling = false;
                            wipeGesture.accumX = 0;
                        }
                    }

                    // ── 手势3：握拳→张开 → stage 2→3（糊纸→上色）──
                    if (currentStage === 2) {
                        const fu = handData.fingersUp;
                        const isFistLike = fu <= 2;
                        const isOpenLike = fu >= 3;
                        if (isFistLike) {
                            bloomGesture.holdFistTime++;
                        } else {
                            if (bloomGesture.holdFistTime > 0) bloomGesture.holdFistTime--;
                        }
                        if (bloomGesture.holdFistTime > 10) {
                            bloomGesture.wasFist = true;
                        }
                        if (bloomGesture.wasFist && isOpenLike) {
                            triggerRitualGesture(3);
                            bloomGesture.wasFist = false;
                            bloomGesture.holdFistTime = 0;
                        }
                    }

                    // ── 手势4：双手靠近→向上托起 → stage 3→4（上色→鱼灯）──
                    if (currentStage === 3) {
                        if (twoHands) {
                            const x0 = hand0[0].x, x1 = hand1[0].x;
                            const y0 = hand0[0].y, y1 = hand1[0].y;
                            const hdist = Math.abs(x0 - x1);
                            const avgY = (y0 + y1) / 2;
                            if (hdist < 0.28) {
                                liftGesture.closeTime++;
                                if (liftGesture.closeTime > 6 && !liftGesture.wasClose) {
                                    liftGesture.wasClose = true;
                                    liftGesture.startY = avgY;
                                    liftGesture.riseAccum = 0;
                                }
                                if (liftGesture.wasClose && liftGesture.startY !== null) {
                                    const rise = liftGesture.startY - avgY; // Y减小=向上
                                    if (rise > liftGesture.riseAccum) liftGesture.riseAccum = rise;
                                    if (liftGesture.riseAccum > 0.08) {
                                        triggerRitualGesture(4);
                                        liftGesture.wasClose = false;
                                        liftGesture.closeTime = 0;
                                        liftGesture.startY = null;
                                        liftGesture.riseAccum = 0;
                                    }
                                }
                            } else {
                                liftGesture.closeTime = Math.max(0, liftGesture.closeTime - 2);
                                if (liftGesture.closeTime === 0) {
                                    liftGesture.wasClose = false;
                                    liftGesture.startY = null;
                                    liftGesture.riseAccum = 0;
                                }
                            }
                        } else {
                            liftGesture.closeTime = 0;
                            liftGesture.wasClose = false;
                            liftGesture.startY = null;
                            liftGesture.riseAccum = 0;
                        }
                    }
                }

                // ── 放生手势：张开五指+手腕上移 → 放生完成 ──
                if (
                    ritualCooldown === 0 &&
                    (
                        currentPhase === PHASES.RELEASE ||
                        (currentPhase === PHASES.CRAFTING && currentStage === 4)
                    )
                ) {
                    const fu = handData.fingersUp;
                    const py = handData.palmY; // -0.5~0.5，负=上方
                    if (fu >= 4) {
                        releaseGesture.openTime++;
                        if (releaseGesture.openTime > 8 && releaseGesture.startY === null) {
                            releaseGesture.startY = py;
                            releaseGesture.riseAccum = 0;
                        }
                        if (releaseGesture.startY !== null) {
                            const rise = releaseGesture.startY - py; // palmY减小=手上移
                            if (rise > releaseGesture.riseAccum) releaseGesture.riseAccum = rise;
                            if (releaseGesture.riseAccum > 0.08) {
                                triggerRitualGesture('release');
                                releaseGesture.openTime = 0;
                                releaseGesture.startY = null;
                                releaseGesture.riseAccum = 0;
                            }
                        }
                    } else {
                        releaseGesture.openTime = Math.max(0, releaseGesture.openTime - 2);
                        if (releaseGesture.openTime === 0) {
                            releaseGesture.startY = null;
                            releaseGesture.riseAccum = 0;
                        }
                    }
                }

                // ── 更新提示文字 ──
                if (currentPhase === PHASES.CRAFTING && !isMorphing) {
                    const hint = GESTURE_HINTS[currentStage] || '';
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl && hint) hintEl.textContent = hint;
                }
                if (currentPhase === PHASES.RELEASE) {
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = isFinalModelVisible ? '浮金鱼影完成 · 3D 模型已现形' : GESTURE_HINTS[1];
                }

                // 在全屏画布上绘制骨骼（镜像翻转）
                drawHandSkeleton(skelCtx, landmarks, skelCanvas.width, skelCanvas.height);
                
                // 将指尖位置传递给水波纹物理系统
                if (waterRipple) {
                    const fingerIndices = [4, 8, 12, 16, 20]; // 拇指、食指、中指、无名指、小指尖
                    const fingerData = fingerIndices.map(idx => ({
                        x: 1.0 - landmarks[idx].x, // X镜像：与骨骼绘制保持一致
                        y: 1.0 - landmarks[idx].y, // Y翻转：MediaPipe y=0在顶部，UV y=0在底部
                        active: true
                    }));
                    waterRipple.setFingerPositions(fingerData);
                }
                
                // 如果有第二只手
                if (results.multiHandLandmarks.length > 1) {
                    drawHandSkeleton(skelCtx, results.multiHandLandmarks[1], skelCanvas.width, skelCanvas.height);
                }

                // 捏合检测 (拇指4 vs 食指8) - 增大阈值防止误触
                const thumb = landmarks[4];
                const index = landmarks[8];
                const dx = thumb.x - index.x;
                const dy = thumb.y - index.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                handData.pinchDist = dist;

                // 捏合阈值
                if (dist < 0.04) {
                    if (!handData.isPinching && handData.pinchCooldown <= 0) {
                        handData.isPinching = true;
                        handData.pinchCooldown = 60;
                        // 根据当前阶段决定行为
                        if (currentPhase === PHASES.WATER) {
                            advancePhase(); // 捏合 → 进入钓鱼
                        } else if (currentPhase === PHASES.FISHING) {
                            advancePhase(); // 捏合 → 抓住鱼 → 制灯
                        } else if (currentPhase === PHASES.RELEASE) {
                            advancePhase(); // 捏合 → 回到水面
                        }
                        // CRAFTING阶段: 捏合不触发阶段切换，形态推进交给仪式手势
                    }
                } else if (dist > 0.08) {
                    handData.isPinching = false;
                }
                
                // 冷却递减
                if (handData.pinchCooldown > 0) handData.pinchCooldown--;

            } else {
                handData.detected = false;
                // 清除水波纹手指数据
                if (waterRipple) {
                    waterRipple.setFingerPositions([]);
                }
            }
        });

        const cam = new Camera(video, {
            onFrame: async () => { await hands.send({ image: video }); },
            width: 320,
            height: 240
        });
        cam.start().then(() => {
            console.log('[INFO] 摄像头启动成功');
            // 注意：不将摄像头画面接入水波纹背景（用户不需要看到人脸）
        }).catch(err => {
            console.warn('[WARN] 摄像头拒绝或不可用:', err);
        });

    } catch (e) {
        console.warn('[WARN] MediaPipe 加载失败（离线），仅键盘/鼠标交互可用:', e);
    }
}

// ═══════════════════════════════════════════════════════
// 麦克风 / 吹气检测
// ═══════════════════════════════════════════════════════
async function setupMicrophone() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const source = audioCtx.createMediaStreamSource(stream);
        micAnalyser = audioCtx.createAnalyser();
        micAnalyser.fftSize = 256;
        micAnalyser.smoothingTimeConstant = 0.5;
        source.connect(micAnalyser);
        micDataArray = new Uint8Array(micAnalyser.frequencyBinCount);
        console.log('[INFO] 麦克风启动成功，吹气检测已激活');
        
        // 显示麦克风图标
        const micIcon = document.getElementById('mic-indicator');
        if (micIcon) micIcon.style.display = 'block';
    } catch (e) {
        console.warn('[WARN] 麦克风不可用:', e.message);
    }
}

/**
 * 检测吹气：分析低频(0-2kHz)的能量是否持续高于阈值
 * 吹气特征：宽频噪声（不像说话有明显谐波）
 */
function detectBlow() {
    if (!micAnalyser || !micDataArray) return 0;
    micAnalyser.getByteFrequencyData(micDataArray);
    
    // 分析低频区域 (bin 0~20 ≈ 0~1.7kHz at 44100Hz, fftSize=256)
    let lowEnergy = 0;
    const lowBins = 20;
    for (let i = 1; i < lowBins; i++) {
        lowEnergy += micDataArray[i];
    }
    lowEnergy /= (lowBins - 1);
    
    // 分析中频区域 (bin 20~60)
    let midEnergy = 0;
    for (let i = 20; i < 60; i++) {
        midEnergy += micDataArray[i];
    }
    midEnergy /= 40;
    
    // 吹气判定：低频强（>80）且中频也有能量（宽频噪声特征）
    const isBlowing = lowEnergy > 80 && midEnergy > 40;
    
    if (isBlowing) {
        // 吹气强度与低频能量成正比
        return Math.min((lowEnergy - 80) / 100, 1.0);
    }
    return 0;
}

// ═══════════════════════════════════════════════════════
// PeerJS 手机连接
// ═══════════════════════════════════════════════════════
let peerConnection = null;

function setupPeerConnection() {
    if (typeof Peer === 'undefined' || typeof qrcode === 'undefined') {
        console.warn('[WARN] PeerJS 或 QRCode 库未加载，手机连接不可用');
        return;
    }

    const peer = new Peer();
    peer.on('open', (id) => {
        console.log('[INFO] PeerJS ID:', id);
        
        // 生成二维码 URL
        const host = location.hostname || 'localhost';
        const port = location.port || '8081';
        const phoneUrl = `http://${host}:${port}/phone.html?peer=${id}`;
        
        const qrCanvas = document.getElementById('qr-canvas');
        if (qrCanvas) {
            // qrcode-generator 库 API
            const qr = qrcode(0, 'M');
            qr.addData(phoneUrl);
            qr.make();
            
            const ctx = qrCanvas.getContext('2d');
            const size = 120;
            qrCanvas.width = size;
            qrCanvas.height = size;
            const modules = qr.getModuleCount();
            const cellSize = size / modules;
            
            ctx.fillStyle = '#0a1a30';
            ctx.fillRect(0, 0, size, size);
            ctx.fillStyle = '#e0d0a0';
            for (let row = 0; row < modules; row++) {
                for (let col = 0; col < modules; col++) {
                    if (qr.isDark(row, col)) {
                        ctx.fillRect(col * cellSize, row * cellSize, cellSize + 0.5, cellSize + 0.5);
                    }
                }
            }
            console.log('[INFO] QR码已生成:', phoneUrl);
        }
    });

    peer.on('connection', (conn) => {
        console.log('[INFO] 手机已连接');
        peerConnection = conn;
        const qrStatus = document.getElementById('qr-status');
        if (qrStatus) qrStatus.textContent = '✅ 手机已连接';
        
        conn.on('data', (data) => {
            handlePhoneData(data);
        });
        
        conn.on('close', () => {
            console.log('[INFO] 手机断开连接');
            peerConnection = null;
            if (qrStatus) qrStatus.textContent = '❌ 已断开';
        });
    });

    peer.on('error', (err) => {
        console.warn('[WARN] PeerJS错误:', err.type);
    });

    // QR 码显示/隐藏
    const qrToggle = document.getElementById('qr-toggle');
    const qrContainer = document.getElementById('qr-container');
    const qrClose = document.getElementById('qr-close');
    
    if (qrToggle && qrContainer) {
        qrToggle.addEventListener('click', () => {
            qrContainer.style.display = 'block';
            qrToggle.style.display = 'none';
        });
    }
    if (qrClose && qrContainer && qrToggle) {
        qrClose.addEventListener('click', () => {
            qrContainer.style.display = 'none';
            qrToggle.style.display = 'block';
        });
    }
}

/**
 * 处理手机端发送的数据
 */
function handlePhoneData(data) {
    if (!data || !data.type) return;
    
    switch (data.type) {
        case 'hand':
            // 手机触摸区域映射为 handData
            handData.detected = data.detected !== false;
            if (data.palmX !== undefined) handData.palmX = data.palmX;
            if (data.palmY !== undefined) handData.palmY = data.palmY;
            if (data.fingersUp !== undefined) handData.fingersUp = data.fingersUp;
            if (data.pinchDist !== undefined) handData.pinchDist = data.pinchDist;
            break;
            
        case 'gesture':
            // 按钮触发的离散手势
            if (data.gesture === 'pinch') {
                handData.isPinching = true;
                handData.pinchCooldown = 60;
                if (currentPhase === PHASES.WATER) advancePhase();
                else if (currentPhase === PHASES.FISHING) advancePhase();
                else if (currentPhase === PHASES.RELEASE) advancePhase();
                setTimeout(() => { handData.isPinching = false; }, 300);
            } else if (data.gesture === 'ritual-next') {
                if (currentPhase === PHASES.CRAFTING) {
                    if (currentStage < STAGES.length - 1) triggerRitualGesture(currentStage + 1);
                    else triggerRitualGesture('release');
                }
            }
            break;
            
        case 'blow':
            // 摇晃手机 → 吹气效果
            if (data.strength > 0) {
                blowStrength = Math.max(blowStrength, data.strength);
            }
            break;
    }
}

// ═══════════════════════════════════════════════════════
// UI 交互绑定
// ═══════════════════════════════════════════════════════
function setupUI() {
    // 面板折叠
    document.getElementById('panel-toggle').addEventListener('click', () => {
        const panel = document.getElementById('control-panel');
        panel.classList.toggle('collapsed');
        const btn = document.getElementById('panel-toggle');
        btn.textContent = panel.classList.contains('collapsed') ? '▶' : '◀';
    });

    // 滑块绑定
    document.getElementById('ctrl-size').addEventListener('input', e => {
        uniforms.uSize.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-relief').addEventListener('input', e => {
        // 3D点云模式不使用 relief
    });
    document.getElementById('ctrl-fluid').addEventListener('input', e => {
        uniforms.uFluidStrength.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-breath').addEventListener('input', e => {
        uniforms.uBreathAmp.value = parseFloat(e.target.value);
    });
    document.getElementById('ctrl-threshold').addEventListener('input', e => {
        uniforms.uThreshold.value = parseFloat(e.target.value);
    });

    // 颜色按钮
    document.querySelectorAll('.color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const color = btn.getAttribute('data-color');
            if (color === 'none') {
                uniforms.uTintStrength.value = 0;
            } else {
                const c = new THREE.Color(color);
                uniforms.uTintColor.value.set(c.r, c.g, c.b);
                uniforms.uTintStrength.value = 1.0;
            }
        });
    });

    // 自定义颜色
    document.getElementById('custom-color').addEventListener('input', e => {
        document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('active'));
        const c = new THREE.Color(e.target.value);
        uniforms.uTintColor.value.set(c.r, c.g, c.b);
        uniforms.uTintStrength.value = 1.0;
    });

    // 水面色调按钮
    document.querySelectorAll('.water-color-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.water-color-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const theme = btn.getAttribute('data-water');
            if (waterRipple) waterRipple.setColorTheme(theme);
        });
    });

    // 场景阶段按钮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const phase = btn.getAttribute('data-phase');
            if (phase) enterPhase(phase);
        });
    });

    // 底部圆点（阶段切换）
    document.querySelectorAll('.dot').forEach(dot => {
        dot.addEventListener('click', () => {
            const idx = parseInt(dot.getAttribute('data-idx'));
            const phases = [PHASES.WATER, PHASES.FISHING, PHASES.CRAFTING, PHASES.RELEASE];
            if (phases[idx]) enterPhase(phases[idx]);
        });
    });

    // 手势超时设置
    for (let i = 0; i < 5; i++) {
        const slider = document.getElementById(`ctrl-timeout-${i}`);
        const label = document.getElementById(`timeout-val-${i}`);
        if (!slider || !label) continue;
        slider.value = String(RITUAL_TIMEOUTS[i]);
        label.textContent = `${RITUAL_TIMEOUTS[i]}s`;
        slider.addEventListener('input', (e) => {
            const value = Math.max(0, parseInt(e.target.value, 10) || 0);
            RITUAL_TIMEOUTS[i] = value;
            label.textContent = `${value}s`;
            resetRitualTimeout();
        });
    }

    const resetBtn = document.getElementById('reset-defaults');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            resetTimeoutDefaults();
        });
    }
}

function resetTimeoutDefaults() {
    RITUAL_TIMEOUTS = [...DEFAULTS.ritualTimeouts];
    for (let i = 0; i < 5; i++) {
        const slider = document.getElementById(`ctrl-timeout-${i}`);
        const label = document.getElementById(`timeout-val-${i}`);
        if (!slider || !label) continue;
        slider.value = String(RITUAL_TIMEOUTS[i]);
        label.textContent = `${RITUAL_TIMEOUTS[i]}s`;
    }
    resetRitualTimeout();
}

function updateUI() {
    // 场景阶段按钮高亮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-phase') === currentPhase);
    });
    updatePhaseIndicator();
}

// ═══════════════════════════════════════════════════════
// Toast 提示
// ═══════════════════════════════════════════════════════
function showToast(msg, duration = 2000) {
    let toast = document.getElementById('fish-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'fish-toast';
        toast.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);padding:10px 24px;background:rgba(0,0,0,0.8);color:#fff;border-radius:8px;font-size:16px;z-index:9999;opacity:0;transition:opacity 0.3s;pointer-events:none;';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => { toast.style.opacity = '0'; }, duration);
}

// ═══════════════════════════════════════════════════════
// 键盘事件
// ═══════════════════════════════════════════════════════
function onKeyDown(e) {
    if (e.code === 'Space') {
        e.preventDefault();
        if (currentPhase === PHASES.WATER) {
            advancePhase(); // 进入钓鱼
        } else if (currentPhase === PHASES.FISHING) {
            advancePhase(); // 抓住鱼 → 制灯
        } else if (currentPhase === PHASES.CRAFTING) {
            if (currentStage < STAGES.length - 1) {
                triggerRitualGesture(currentStage + 1); // 调试兜底：按顺序模拟仪式完成
            } else {
                triggerRitualGesture('release');
            }
        } else if (currentPhase === PHASES.RELEASE) {
            advancePhase(); // 回到水面
        }
    }
    // 数字键1-4切换阶段（调试用）
    if (!e.shiftKey) {
        if (e.code === 'Digit1') enterPhase(PHASES.WATER);
        if (e.code === 'Digit2') enterPhase(PHASES.FISHING);
        if (e.code === 'Digit3') enterPhase(PHASES.CRAFTING);
        if (e.code === 'Digit4') enterPhase(PHASES.RELEASE);
    }

    // Shift+1-5 切换鱼种（隐藏快捷键）
    if (e.shiftKey) {
        if (e.code === 'Digit1') switchFishType(0);
        if (e.code === 'Digit2') switchFishType(1);
        if (e.code === 'Digit3') switchFishType(2);
        if (e.code === 'Digit4') switchFishType(3);
        if (e.code === 'Digit5') switchFishType(4);
    }

    // 左右方括号也可切换鱼种
    if (e.code === 'BracketLeft')  switchFishType(currentFishIndex - 1);
    if (e.code === 'BracketRight') switchFishType(currentFishIndex + 1);
}

// ═══════════════════════════════════════════════════════
// 窗口大小调整
// ═══════════════════════════════════════════════════════
function onResize() {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
    if (waterRipple) waterRipple.resize(window.innerWidth, window.innerHeight);
}

// ═══════════════════════════════════════════════════════
// 钓鱼线 + 鱼钩 (2D线条)
// ═══════════════════════════════════════════════════════
function createFishingLine() {
    if (fishingLine) { scene.remove(fishingLine); fishingLine = null; }
    const group = new THREE.Group();
    
    // 鱼线：从画面顶部垂下的曲线
    const lineMat = new THREE.LineBasicMaterial({ color: 0xcccccc, linewidth: 1.5, transparent: true, opacity: 0.7 });
    const lineGeo = new THREE.BufferGeometry();
    // 初始点位，后续 animate 中动态更新
    const pts = [];
    for (let i = 0; i <= 20; i++) {
        pts.push(0, 0, 0);
    }
    lineGeo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const line = new THREE.Line(lineGeo, lineMat);
    line.name = 'fishing-line';
    group.add(line);
    
    // 鱼钩：简单的弯钩形状
    const hookMat = new THREE.LineBasicMaterial({ color: 0x888888, linewidth: 2 });
    const hookShape = new THREE.BufferGeometry();
    const hookPts = [
        0, 0, 0,       // 连接点
        0, -3, 0,      // 直杆
        1, -5, 0,      // 弯曲开始
        2, -4.5, 0,    // 钩尖
        1.5, -3.5, 0,  // 倒刺
    ];
    hookShape.setAttribute('position', new THREE.Float32BufferAttribute(hookPts, 3));
    const hook = new THREE.Line(hookShape, hookMat);
    hook.name = 'fishing-hook';
    group.add(hook);
    
    group.visible = true;
    scene.add(group);
    fishingLine = group;
}

function updateFishingLine(time) {
    if (!fishingLine) return;
    const line = fishingLine.getObjectByName('fishing-line');
    const hook = fishingLine.getObjectByName('fishing-hook');
    if (!line) return;
    
    // 鱼线从画面上方（竿的位置）垂下到鱼钩位置
    const rodX = 15;  // 竿在右上方
    const rodY = 65;  // 画面顶部
    
    // 鱼钩终点：正常摆动 or 跟随鱼嘴位置（咬钩后）
    let hookX, hookY;
    if (fishingState >= FISH_STATE.BITING && fishDartCtrl) {
        // 咬钩后鱼线连接鱼嘴（鼻子方向偏移）
        const dir = fishDartCtrl.direction;
        const mouthOffset = 12;
        hookX = fishDartCtrl.pos.x + dir.x * mouthOffset;
        hookY = fishDartCtrl.pos.y + dir.y * mouthOffset;
    } else {
        hookX = rodX + Math.sin(time * 0.8) * 5;
        hookY = -10 + Math.sin(time * 0.5) * 3;
    }
    
    // 挣扎时线的抖动
    const tension = fishingState === FISH_STATE.STRUGGLING ? Math.sin(time * 12) * 3 : 0;
    
    // 用二次贝塞尔曲线生成鱼线点
    const positions = line.geometry.attributes.position.array;
    const segments = 20;
    const ctrlX = (rodX + hookX) * 0.5 + tension;
    const ctrlY = (rodY + hookY) * 0.5 + 10;
    
    for (let i = 0; i <= segments; i++) {
        const t = i / segments;
        const x = (1-t)*(1-t)*rodX + 2*(1-t)*t*ctrlX + t*t*hookX;
        const y = (1-t)*(1-t)*rodY + 2*(1-t)*t*ctrlY + t*t*hookY;
        positions[i*3] = x;
        positions[i*3+1] = y;
        positions[i*3+2] = 1;
    }
    line.geometry.attributes.position.needsUpdate = true;
    
    // 更新鱼钩位置
    if (hook) {
        hook.position.set(hookX, hookY, 1);
        // 咬钩后隐藏独立鱼钩（鱼嘴含着）
        hook.visible = fishingState < FISH_STATE.BITING;
    }
}

// ═══════════════════════════════════════════════════════
// 动画循环
// ═══════════════════════════════════════════════════════
function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();
    const time = clock.getElapsedTime();

    // 更新 uniforms
    uniforms.uTime.value = time;

    // RELEASE 阶段：更新鱼群 boids
    if (currentPhase === PHASES.RELEASE && fishSchool) {
        const handPos = handData.detected
            ? new THREE.Vector2(-handData.palmX * 100, -handData.palmY * 70)
            : null;
        fishSchool.update(dt, time, handPos);
        // 鱼群气泡：随机从某条鱼尾部冒泡
        if (bubbleSystem && Math.random() < 0.08) {
            const randomFish = fishSchool.fishes[Math.floor(Math.random() * fishSchool.fishes.length)];
            if (randomFish) {
                const dir = randomFish.direction;
                const tailX = randomFish.pos.x - dir.x * 10;
                const tailY = randomFish.pos.y - dir.y * 10;
                bubbleSystem.emit(tailX, tailY, 1, { sizeMin: 1.0, sizeMax: 2.5, speedUp: 10, spread: 2 });
            }
        }
    }

    // CRAFTING 阶段：鱼模型自身缓慢旋转展示 + 摆尾 + 浮动
    if (currentPhase === PHASES.CRAFTING && fishMeshGroup && fishMeshGroup.visible) {
        // 鱼自身绕Y轴缓慢旋转展示各角度（不动相机/水面）
        fishMeshGroup.rotation.y += 0.3 * dt;
        // 上下浮动
        fishMeshGroup.position.y = Math.sin(time * 0.8) * 3;
        // 更新顶点着色器（加大振幅使侧面可见）
        if (fishSwimCtrl) {
            fishSwimCtrl.uniforms.uSwimTime.value = time;
            fishSwimCtrl.uniforms.uSwimSpeed.value = 2.5;
            fishSwimCtrl.uniforms.uSwimAmp.value = 0.25;
        }
    }

    // 鱼灯点亮仪式动画
    if (lanternGlowing && lanternMeshGroup && lanternMeshGroup.visible) {
        lanternGlowProgress = Math.min(1.0, lanternGlowProgress + dt * 0.4); // 约2.5秒完全点亮
        const glow = lanternGlowProgress * lanternGlowProgress; // ease-in
        // 鱼灯材质发光
        lanternMeshGroup.traverse((obj) => {
            if (obj.isMesh && obj.material && obj.material.emissive) {
                obj.material.emissiveIntensity = glow * 0.8;
                // 暖色调发光
                obj.material.emissive.setRGB(1.0, 0.6, 0.2);
            }
        });
        // 内部点光源
        if (lanternPointLight) {
            lanternPointLight.intensity = glow * 3.0;
            // 呼吸闪烁
            const flicker = 1.0 + Math.sin(time * 4) * 0.1 + Math.sin(time * 7) * 0.05;
            lanternPointLight.intensity *= flicker;
        }
        if (lanternGlowProgress >= 1.0) lanternGlowing = false;
    }

    // 更新物理水波纹
    if (waterRipple) {
        waterRipple.update(time);
        if (rippleMesh) {
            rippleMesh.material.map = waterRipple.getOutputTexture();
            rippleMesh.material.needsUpdate = true;
        }
    }

    // 阶段特殊动画
    if (currentPhase === PHASES.WATER) {
        // 水面阶段：当手指触水时，逐渐吸引鱼影
        if (handData.detected) {
            fishAttractionTimer += dt;
            // 手指触水超过2.5秒 → 自动进入钓鱼阶段（鱼影出现）
            if (fishAttractionTimer > 2.5) {
                enterPhase(PHASES.FISHING);
            }
            // 提示变化
            if (fishAttractionTimer > 1.0) {
                const hintEl = document.getElementById('hint-text');
                if (hintEl) hintEl.textContent = '水中似乎有动静...';
            }
        } else {
            fishAttractionTimer = Math.max(0, fishAttractionTimer - dt * 0.5);
        }
    }
    
    if (currentPhase === PHASES.FISHING && fishMeshGroup && fishDartCtrl) {
        // 钓鱼阶段状态机
        fishMeshSwimTime += dt;
        fishingStateTimer += dt;
        const fadeIn = Math.min(fishMeshSwimTime * 0.5, 1.0);

        // 鱼钩位置（与 updateFishingLine 保持同步）
        const hookX = 15 + Math.sin(time * 0.8) * 5;
        const hookY = -10 + Math.sin(time * 0.5) * 3;

        switch (fishingState) {
            case FISH_STATE.SWIMMING:
                // 自由游动阶段，等待延时后自动靠近鱼钩
                if (handData.detected && fadeIn > 0.5) {
                    fishDartCtrl.attractTo(-handData.palmX * 80, -handData.palmY * 60);
                }
                fishDartCtrl.update(dt);
                // 延时后自动进入靠近状态
                if (fishingStateTimer > fishingApproachDelay) {
                    fishingState = FISH_STATE.APPROACHING;
                    fishingStateTimer = 0;
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '🐟 鱼发现了鱼饵...';
                }
                break;

            case FISH_STATE.APPROACHING:
                // 鱼自动向鱼钩方向游去
                fishDartCtrl.attractTo(hookX, hookY);
                fishDartCtrl.update(dt);
                // 检测是否到达鱼钩附近（半径放宽以匹配转向弧线）
                const distToHook = Math.hypot(fishDartCtrl.pos.x - hookX, fishDartCtrl.pos.y - hookY);
                if (distToHook < 25) {
                    fishingState = FISH_STATE.BITING;
                    fishingStateTimer = 0;
                    // 咬钩水花爆发
                    if (splashSystem) splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 25, power: 60, color: [0.6, 0.9, 1.0] });
                    // 屏幕震动
                    document.body.style.animation = 'screenShake 0.4s ease-out';
                    setTimeout(() => { document.body.style.animation = ''; }, 400);
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '🎣 鱼咬钩了！';
                    showToast('🎣 鱼咬钩了！', 1500);
                }
                break;

            case FISH_STATE.BITING:
                // 咬钩瞬间：鱼停在钩旁，短暂停顿后进入挣扎
                fishDartCtrl.pos.x += (hookX - fishDartCtrl.pos.x) * dt * 5;
                fishDartCtrl.pos.y += (hookY - fishDartCtrl.pos.y) * dt * 5;
                if (fishingStateTimer > 0.8) {
                    fishingState = FISH_STATE.STRUGGLING;
                    fishingStateTimer = 0;
                    fishingStruggleCount = 0;
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '💪 鱼在挣扎！保持住...';
                }
                break;

            case FISH_STATE.STRUGGLING:
                // 鱼在鱼钩附近剧烈挣扎（左右猛甩 + 向下拉扯）
                const struggleAmp = 15 * Math.max(0.3, 1 - fishingStateTimer * 0.15);
                const struggleFreq = 8 + fishingStruggleCount * 0.5;
                fishDartCtrl.pos.x = hookX + Math.sin(time * struggleFreq) * struggleAmp;
                fishDartCtrl.pos.y = hookY - 5 + Math.sin(time * struggleFreq * 1.3) * (struggleAmp * 0.5);
                fishDartCtrl.heading = Math.sin(time * struggleFreq) * 0.8; // 头部猛甩
                fishingStruggleCount++;
                // 轻微持续屏幕抖动
                if (Math.random() < 0.1) {
                    document.body.style.transform = `translate(${(Math.random()-0.5)*3}px, ${(Math.random()-0.5)*2}px)`;
                    setTimeout(() => { document.body.style.transform = ''; }, 50);
                }
                // 挣扎4秒后鱼力竭，被钓上
                if (fishingStateTimer > 4.0) {
                    fishingState = FISH_STATE.CAUGHT;
                    fishingStateTimer = 0;
                    // 被钓起时大水花
                    if (splashSystem) splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 35, power: 90, color: [0.7, 0.95, 1.0] });
                    const hintEl = document.getElementById('hint-text');
                    if (hintEl) hintEl.textContent = '🏆 成功钓到了！';
                    showToast(`🏆 钓到了 ${FISH_TYPES[currentFishIndex].name}！`, 2500);
                    document.body.style.transform = '';
                }
                break;

            case FISH_STATE.CAUGHT:
                // 鱼被钓上：向上收线动画
                fishDartCtrl.pos.y += 40 * dt; // 向上拉
                fishDartCtrl.heading = Math.PI / 2; // 头朝上
                // 1.5秒后自动进入制灯阶段
                if (fishingStateTimer > 1.5) {
                    advancePhase();
                }
                break;
        }

        // 非SWIMMING/APPROACHING状态下手动改了heading，需同步3D朝向
        if (fishingState >= FISH_STATE.BITING) {
            const pitchVal = fishingState === FISH_STATE.CAUGHT ? 0.3 : 0;
            // 方向强制XY平面（纯侧影）
            fishDartCtrl.direction.set(
                Math.cos(fishDartCtrl.heading),
                Math.sin(fishDartCtrl.heading) * 0.4 + pitchVal,
                0
            ).normalize();
            // matrix-based quaternion（鱼背朝上）
            const _right = new THREE.Vector3();
            const _corrUp = new THREE.Vector3();
            const _mat = new THREE.Matrix4();
            const _wUp = new THREE.Vector3(0, 1, 0);
            _right.crossVectors(_wUp, fishDartCtrl.direction);
            if (_right.lengthSq() < 0.001) _right.set(0, 0, -1);
            _right.normalize();
            _corrUp.crossVectors(fishDartCtrl.direction, _right).normalize();
            _mat.makeBasis(_right, _corrUp, fishDartCtrl.direction);
            fishDartCtrl.quaternion.setFromRotationMatrix(_mat);
        }

        // 应用位置（3D）
        fishMeshGroup.position.x = fishDartCtrl.pos.x;
        fishMeshGroup.position.y = fishDartCtrl.pos.y;
        fishMeshGroup.position.z = fishDartCtrl.pos.z;

        // 身体摇摆（S-wave尾部振动）：振幅与速度联动，挣扎时更剧烈
        const speedRatio = fishDartCtrl.speed / 150;
        const wiggleBase = fishingState === FISH_STATE.STRUGGLING ? 0.35 : (0.04 + speedRatio * 0.08);
        const wiggleFreq = 3.0 + speedRatio * 2.5;
        const swimWiggle = Math.sin(time * wiggleFreq) * wiggleBase;
        
        // 3D朝向：使用四元数，鱼鼻子对准速度方向
        fishMeshGroup.quaternion.copy(fishDartCtrl.quaternion);
        // 叠加局部Y轴摆尾
        fishMeshGroup.rotateY(swimWiggle);

        // 更新顶点着色器时间（如果注入成功）
        if (fishSwimCtrl) {
            fishSwimCtrl.uniforms.uSwimTime.value = time;
            fishSwimCtrl.uniforms.uSwimSpeed.value = 2.0 + speedRatio * 3.0;
            fishSwimCtrl.uniforms.uSwimAmp.value = 0.12 + speedRatio * 0.15;
        }

        // 鱼鳞微光：转弯时鳞片反光闪烁
        const bank = fishDartCtrl.bankAngle || 0;
        const shimmerStrength = Math.abs(bank) * 2.0 + speedRatio * 0.3;
        const sparkle = Math.max(0, Math.sin(time * 8 + Math.sin(time * 3) * 2)) * shimmerStrength;
        fishMeshGroup.traverse((obj) => {
            if (obj.isMesh && obj.material && obj.material.emissive) {
                obj.material.emissiveIntensity = 0.05 + sparkle * 0.4;
            }
        });

        // 渐入透明度
        if (fadeIn < 1.0) {
            fishMeshGroup.traverse((obj) => {
                if (obj.isMesh && obj.material) {
                    obj.material.transparent = true;
                    obj.material.opacity = fadeIn;
                }
            });
        }
        
        // 更新钓鱼线动画
        updateFishingLine(time);

        // 气泡：从鱼尾部定期释放
        if (bubbleSystem && Math.random() < 0.15) {
            const tailOffset = 15;
            const dir = fishDartCtrl.direction;
            const tailX = fishDartCtrl.pos.x - dir.x * tailOffset;
            const tailY = fishDartCtrl.pos.y - dir.y * tailOffset;
            bubbleSystem.emit(tailX, tailY, 1, { sizeMin: 1.0, sizeMax: 3.0, speedUp: 12, spread: 3 });
        }
        // 水花：挣扎时持续溅水
        if (splashSystem && fishingState === FISH_STATE.STRUGGLING && Math.random() < 0.3) {
            splashSystem.burst(fishDartCtrl.pos.x, fishDartCtrl.pos.y, { count: 3, power: 50 });
        }
    }

    // 状态超时保护：超时自动切换
    if (!phaseTransitioning) {
        if (currentPhase === PHASES.CRAFTING && !isBoidsMode) {
            ritualTimeoutTimer += dt;
            const limit = RITUAL_TIMEOUTS[currentStage] ?? 0;
            if (limit > 0 && ritualTimeoutTimer >= limit) {
                ritualTimeoutTimer = 0;
                if (currentStage < STAGES.length - 1) {
                    triggerRitualGesture(currentStage + 1);
                } else {
                    triggerRitualGesture('release');
                }
            }
        } else if (currentPhase === PHASES.RELEASE) {
            // 放生阶段不需要超时自动推进，鱼群持续游动直到用户手势结束
        }
    }

    // 形态变形进度
    if (isMorphing) {
        morphProgress += dt / CONFIG.morphDuration;
        if (morphProgress >= 1.0) {
            morphProgress = 1.0;
            isMorphing = false;
            // morph 结束后，A 变成 B
            uniforms.uPosA.value = uniforms.uPosB.value;
            uniforms.uColA.value = uniforms.uColB.value;
            uniforms.uMorph.value = 0.0;
            // 移除背景暗化
            morphOverlay.style.opacity = '0';
            // TD粒子变形结束：隐藏粒子，显示目标GLB
            if (particleSystem) particleSystem.visible = false;
            if (currentStage === 1 && lanternMeshGroup) {
                showLanternModel();
            } else if (currentStage === 0 && fishMeshGroup) {
                fishMeshGroup.visible = true;
            }
        } else {
            // 使用 ease-in-out
            const t = morphProgress;
            uniforms.uMorph.value = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        }
    }

    // 手势控制（仅在制灯阶段有效）
    if (!isBoidsMode && currentPhase === PHASES.CRAFTING) {
        const ritualOnlyVisuals = true;

        if (ritualOnlyVisuals) {
            // 仅允许仪式手势推进，不让其他手势影响画面
            if (particleSystem) {
                particleSystem.position.x *= 0.95;
                particleSystem.position.y *= 0.95;
            }
            openPalmHoldTime = 0;
            scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            uniforms.uScatter.value = scatterStrength;
            controls.autoRotate = true;
        } else if (handData.detected) {
            // 粒子跟随手掌位置
            if (particleSystem) {
                // 握拳时强力吸引，其他手型柔和跟随
                const isFist = handData.fingersUp <= 1;
                const range = isFist ? 60 : 40;
                const rangeY = isFist ? 50 : 30;
                const lerpSpeed = isFist ? 0.10 : 0.04;
                const targetX = -handData.palmX * range;
                const targetY = -handData.palmY * rangeY;
                particleSystem.position.x += (targetX - particleSystem.position.x) * lerpSpeed;
                particleSystem.position.y += (targetY - particleSystem.position.y) * lerpSpeed;
            }

            // 仪式手势阶段禁用“张手散开”，避免与固定手势冲突
            const allowOpenPalmScatter = false;
            if (allowOpenPalmScatter && handData.fingersUp >= 4) {
                openPalmHoldTime += dt;
                if (openPalmHoldTime > 0.5) {
                    scatterStrength = Math.min(scatterStrength + dt * 2.0, 1.0);
                }
            } else {
                openPalmHoldTime = 0;
                scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            }
            // 更新散开 uniform 和手掌世界坐标
            uniforms.uScatter.value = scatterStrength;
            uniforms.uHandWorld.value.set(-handData.palmX * 120, -handData.palmY * 120, 0);

            // 禁用轨道自动旋转（手势优先）
            controls.autoRotate = false;
        } else {
            // 无手势时归位并恢复自动旋转
            if (particleSystem) {
                particleSystem.position.x *= 0.95;
                particleSystem.position.y *= 0.95;
            }
            scatterStrength = Math.max(scatterStrength - dt * 2.0, 0.0);
            uniforms.uScatter.value = scatterStrength;
            controls.autoRotate = true;
        }
    }

    // 鱼群模式更新
    if (isBoidsMode) {
        const ritualOnlyVisuals = true;
        if (ritualOnlyVisuals) {
            // 放生阶段仅允许“放生手势”切换，不让其他手势影响鱼群
            const target = new THREE.Vector3(
                Math.sin(time * 0.3) * 60,
                Math.cos(time * 0.4) * 40,
                0
            );
            updateBoids(target, 'follow');
        } else if (handData.detected) {
            const hx = -handData.palmX * 180;
            const hy = -handData.palmY * 180;
            if (handData.fingersUp <= 1) {
                // 握拳：鱼群强烈追随拳头位置
                updateBoids(new THREE.Vector3(hx, hy, 0), 'attract');
            } else if (handData.fingersUp >= 4) {
                // 张手：鱼群从手掌散开
                updateBoids(new THREE.Vector3(hx, hy, 0), 'scatter');
            } else {
                // 中间状态：温和跟随
                updateBoids(new THREE.Vector3(hx, hy, 0), 'follow');
            }
        } else {
            // 无手势时自由游动
            const target = new THREE.Vector3(
                Math.sin(time * 0.3) * 60,
                Math.cos(time * 0.4) * 40,
                0
            );
            updateBoids(target, 'follow');
        }
    }

    // 吹气检测 → 风力效果
    const blowRaw = detectBlow();
    if (blowRaw > 0) {
        blowStrength = Math.min(blowStrength + dt * 4.0, blowRaw);
    } else {
        blowStrength = Math.max(blowStrength - dt * 2.0, 0);
    }
    if (uniforms) {
        uniforms.uWind.value = blowStrength;
    }
    // 吹气时水波纹也产生扰动
    if (blowStrength > 0.1 && waterRipple) {
        // 在随机位置产生波纹（模拟风吹水面）
        const windFingers = [];
        for (let i = 0; i < 3; i++) {
            windFingers.push({
                x: Math.random(),
                y: Math.random(),
                active: true
            });
        }
        waterRipple.setFingerPositions(windFingers);
    }
    // 麦克风指示器
    const micInd = document.getElementById('mic-indicator');
    if (micInd) {
        micInd.style.opacity = blowStrength > 0.1 ? '1' : '0.5';
        micInd.style.transform = blowStrength > 0.1 ? 'scale(1.2)' : 'scale(1)';
    }

    controls.update();

    // 更新水下特效
    if (bubbleSystem) bubbleSystem.update(dt);
    if (splashSystem) splashSystem.update(dt);
    if (causticsEffect) {
        causticsEffect.update(time);
        // 焦散面始终面对相机（不跟随场景旋转）
        causticsEffect.mesh.quaternion.copy(camera.quaternion);
        // 焦散在钓鱼和放生阶段更明显
        const targetIntensity = (currentPhase === PHASES.FISHING || currentPhase === PHASES.RELEASE) ? 0.85 : 0.4;
        causticsEffect.uniforms.uIntensity.value += (targetIntensity - causticsEffect.uniforms.uIntensity.value) * 0.02;
    }
    
    // 渲染顺序：先水波纹背景（屏幕空间），再3D场景叠加
    if (rippleScene && rippleCamera) {
        renderer.autoClear = true;
        renderer.render(rippleScene, rippleCamera);
        renderer.autoClear = false;
        renderer.clearDepth(); // 清除深度缓冲，确保3D场景（含焦散）不被背景遮挡
        renderer.render(scene, camera);
        renderer.autoClear = true;
    } else {
        renderer.render(scene, camera);
    }
}

// ═══════════════════════════════════════════════════════
// 启动！
// ═══════════════════════════════════════════════════════
init();
