/**
 * 钓一盏鱼灯 - 粒子点云交互系统
 * 核心架构：纹理驱动粒子网格 + 手势控制 + 形态变换 + 鱼群模式
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { WaterRipple } from './water-ripple.js';

// ═══════════════════════════════════════════════════════
// 配置
// ═══════════════════════════════════════════════════════
const CONFIG = {
    particleGrid: 256,        // 256×256 = 65536 粒子
    pointSize: 2.5,
    relief: 0.0,              // 3D 浮雕深度（默认平面，手势散开）
    bgColor: 0x080810,
    cameraZ: 160,
    morphDuration: 1.5,       // 形态切换秒数
    boidsCount: 600,          // 鱼群数量
    finalModelUrl: 'assets/models/浮金鱼影tripo.glb',
};

const DEFAULTS = {
    pointSize: 2.5,
    relief: 0.0,
    fluidStrength: 0.0,
    breathAmp: 0.02,
    threshold: 0.85,
    tintColor: '#ffffff',
    tintStrength: 0.0,
    waterTheme: 'blue',
    ritualTimeouts: [12, 15, 18, 18, 15],
};
const SFX_GAIN = 0.18;

// 形态贴图列表（活鱼→鱼灯→骨架→糊纸→上色）
const STAGES = [
    { name: '活鱼', url: 'assets/01_reference/carp/live_carp.png' },
    { name: '骨架', url: 'assets/01_reference/carp/frame_carp.png' },
    { name: '糊纸', url: 'assets/01_reference/carp/process_02_paper_skin_unpainted.png' },
    { name: '上色', url: 'assets/01_reference/carp/process_03_painted_unlit.png' },
    { name: '鱼灯', url: 'assets/01_reference/carp/lantern_carp.png' },
];

// ═══════════════════════════════════════════════════════
// Shader 代码
// ═══════════════════════════════════════════════════════

const vertexShader = /* glsl */`
    uniform float uTime;
    uniform float uRelief;
    uniform float uSize;
    uniform float uMorph;         // 0~1 变形进度
    uniform float uBreathAmp;
    uniform float uFluidStrength;
    uniform float uScatter;       // 手势散开力度 0~1
    uniform vec3 uHandWorld;      // 手掌在世界空间的3D位置
    uniform float uWind;          // 吹气风力 0~1
    uniform sampler2D uTexA;      // 当前形态纹理
    uniform sampler2D uTexB;      // 目标形态纹理

    attribute vec2 aUv;

    varying vec2 vUv;
    varying float vLuma;
    varying float vAlpha;

    void main() {
        vUv = aUv;

        // 采样两个纹理的亮度
        vec4 colA = texture2D(uTexA, aUv);
        vec4 colB = texture2D(uTexB, aUv);
        vec4 col = mix(colA, colB, uMorph);
        
        float lumaA = dot(colA.rgb, vec3(0.299, 0.587, 0.114));
        float lumaB = dot(colB.rgb, vec3(0.299, 0.587, 0.114));
        float luma = mix(lumaA, lumaB, uMorph);
        vLuma = luma;
        vAlpha = col.a;

        vec3 pos = position;

        // 3D 浮雕：亮度越高凸起越多 (暗部在前/亮部在后，可以反转)
        pos.z += (1.0 - luma) * uRelief;

        // 游动动画：身体S形波浪 + 尾部大幅摆动 + 鳍摆动
        float tailFactor = smoothstep(-0.2, 0.6, aUv.x); // 尾部→头部权重
        // 身体S形传播波（从头到尾递增）
        float bodyWave = sin(aUv.x * 8.0 - uTime * 4.0) * tailFactor * 4.5;
        pos.y += bodyWave;
        // 尾部额外大幅摆动
        float tailExtra = smoothstep(0.6, 1.0, aUv.x);
        pos.y += sin(uTime * 5.0 - aUv.x * 3.0) * tailExtra * 6.0;
        // 胸鳍区域微振（身体中部两侧）
        float finArea = smoothstep(0.2, 0.4, aUv.x) * smoothstep(0.6, 0.4, aUv.x);
        float finWave = sin(uTime * 8.0) * finArea * abs(aUv.y - 0.5) * 3.0;
        pos.z += finWave;
        // 整体上下浮动
        pos.y += sin(uTime * 1.0) * 2.5;
        // 轻微左右游动
        pos.x += sin(uTime * 0.7) * 1.5;

        // 流动扰动
        float noise = sin(pos.y * 0.08 + uTime * 1.5) * cos(pos.x * 0.08 + uTime);
        pos.x += noise * uFluidStrength * (1.0 - luma);
        pos.y += noise * uFluidStrength * 0.5;

        // 呼吸
        float breath = 1.0 + sin(uTime * 2.0) * uBreathAmp;
        pos *= breath;

        // 变形时散开效果
        float scatter = sin(uMorph * 3.14159);
        float rnd = fract(sin(dot(aUv, vec2(12.9898, 78.233))) * 43758.5453);
        pos += (vec3(rnd, fract(rnd*13.7), fract(rnd*7.3)) - 0.5) * scatter * 15.0;

        // 手势散开/聚拢：张手时粒子整体向外爆炸式扩散
        if (uScatter > 0.01) {
            // 从模型中心向外推开（每个粒子沿自身位置方向散开）
            float d = length(pos);
            if (d > 0.1) {
                vec3 dir = normalize(pos);
                // 加入随机偏移让散开更自然
                float rnd2 = fract(sin(dot(aUv * 3.7, vec2(53.1, 97.3))) * 2847.3);
                float push = uScatter * (35.0 + rnd2 * 25.0);
                pos += dir * push;
                // Z方向也散开（3D效果）
                pos.z += (rnd2 - 0.5) * uScatter * 30.0;
            }
        }

        // 吹气风力：粒子向右飘散 + 随机抖动
        if (uWind > 0.01) {
            float windRnd = fract(sin(dot(aUv + uTime * 0.1, vec2(37.1, 81.7))) * 4375.5);
            pos.x += uWind * (20.0 + windRnd * 30.0);
            pos.y += uWind * (windRnd - 0.5) * 15.0;
            pos.z += uWind * (windRnd - 0.3) * 8.0;
        }

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        gl_PointSize = uSize * (300.0 / -mvPosition.z);
        gl_Position = projectionMatrix * mvPosition;
    }
`;

const fragmentShader = /* glsl */`
    uniform sampler2D uTexA;
    uniform sampler2D uTexB;
    uniform float uMorph;
    uniform float uThreshold;
    uniform vec3 uTintColor;
    uniform float uTintStrength;

    varying vec2 vUv;
    varying float vLuma;
    varying float vAlpha;

    void main() {
        // 插值颜色
        vec4 colA = texture2D(uTexA, vUv);
        vec4 colB = texture2D(uTexB, vUv);
        vec4 color = mix(colA, colB, uMorph);

        // 去除高亮背景（白色/接近白色的部分）
        if (vLuma > uThreshold) discard;
        // 去除全黑
        if (vLuma < 0.02) discard;

        // 圆形粒子
        vec2 coord = gl_PointCoord - vec2(0.5);
        if (length(coord) > 0.5) discard;

        // 柔化边缘
        float edgeFade = 1.0 - smoothstep(0.35, 0.5, length(coord));

        // 染色叠加
        vec3 rgb = color.rgb;
        if (uTintStrength > 0.01) {
            rgb = mix(rgb, rgb * uTintColor, uTintStrength * 0.6);
        }

        // 轻微金色高光增强
        vec3 gold = vec3(0.83, 0.68, 0.21);
        rgb = mix(rgb, gold, vLuma * 0.08);

        gl_FragColor = vec4(rgb, edgeFade * 0.95);
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
    0: '双手张开向两侧推 · 展开竹骨架',
    1: '单手从左向右缓慢抹过 · 糊上竹纸',
    2: '握拳，感受墨色，再缓缓张开',
    3: '双手靠近，向上托起 · 点亮鱼灯',
    4: '张开手掌引导鱼群 · 向上抬手放生',
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
        kicker: '制灯 1/5',
        title: '双手向两侧推开',
        subtitle: '像撑开竹篾一样，让鱼的骨架展开。',
    },
    1: {
        gesture: 'wipe',
        kicker: '制灯 2/5',
        title: '单手从左向右抹过',
        subtitle: '像把纸面覆上鱼身，动作要平稳。',
    },
    2: {
        gesture: 'bloom',
        kicker: '制灯 3/5',
        title: '先握拳，再缓缓张开',
        subtitle: '让颜色从掌心散开，点染鱼鳞。',
        hands: ['✊', '✋'],
    },
    3: {
        gesture: 'lift',
        kicker: '制灯 4/5',
        title: '两手张开，靠拢向上托',
        subtitle: '像把鱼灯捧起来：双手从两侧靠近，然后一起上抬。',
    },
    4: {
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
function loadTextures() {
    return new Promise((resolve) => {
        const loader = new THREE.TextureLoader();
        let loaded = 0;
        
        STAGES.forEach((stage, i) => {
            loader.load(stage.url, (tex) => {
                tex.minFilter = THREE.LinearFilter;
                tex.magFilter = THREE.LinearFilter;
                textures[i] = tex;
                loaded++;
                console.log(`[INFO] 纹理加载完成: ${stage.name} (${loaded}/${STAGES.length})`);
                if (loaded === STAGES.length) resolve();
            }, undefined, (err) => {
                console.warn(`[WARN] 纹理加载失败: ${stage.url}`, err);
                // 创建一个占位纹理
                const canvas = document.createElement('canvas');
                canvas.width = canvas.height = 256;
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#222';
                ctx.fillRect(0, 0, 256, 256);
                ctx.fillStyle = '#d4af37';
                ctx.font = '24px serif';
                ctx.fillText(stage.name, 80, 130);
                textures[i] = new THREE.CanvasTexture(canvas);
                loaded++;
                if (loaded === STAGES.length) resolve();
            });
        });
    });
}

// ═══════════════════════════════════════════════════════
// 粒子系统
// ═══════════════════════════════════════════════════════
function createParticleSystem() {
    const count = CONFIG.particleGrid;
    const numParticles = count * count;

    const geometry = new THREE.BufferGeometry();
    const positions = new Float32Array(numParticles * 3);
    const uvs = new Float32Array(numParticles * 2);

    let idx = 0;
    for (let y = 0; y < count; y++) {
        for (let x = 0; x < count; x++) {
            const u = x / count;
            const v = y / count;

            positions[idx * 3]     = (0.5 - u) * 180; // X: 翻转使鱼头朝右
            positions[idx * 3 + 1] = (0.5 - v) * 180; // Y: 翻转使鱼正朝上
            positions[idx * 3 + 2] = 0;                // Z (由shader计算)

            uvs[idx * 2]     = u;
            uvs[idx * 2 + 1] = 1.0 - v; // UV的V翻转：图像y=0在顶部，OpenGL纹理y=0在底部

            idx++;
        }
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aUv', new THREE.BufferAttribute(uvs, 2));

    uniforms = {
        uTime:          { value: 0 },
        uTexA:          { value: textures[0] },
        uTexB:          { value: textures[0] },
        uMorph:         { value: 0.0 },
        uSize:          { value: CONFIG.pointSize },
        uRelief:        { value: CONFIG.relief },
        uThreshold:     { value: 0.85 },
        uBreathAmp:     { value: 0.02 },
        uFluidStrength: { value: 0.0 },
        uScatter:       { value: 0.0 },
        uHandWorld:     { value: new THREE.Vector3(0, 0, 0) },
        uWind:          { value: 0.0 },
        uTintColor:     { value: new THREE.Vector3(1, 1, 1) },
        uTintStrength:  { value: 0.0 },
    };

    const material = new THREE.ShaderMaterial({
        uniforms,
        vertexShader,
        fragmentShader,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
    });

    particleSystem = new THREE.Points(geometry, material);
    particleSystem.frustumCulled = false;
    scene.add(particleSystem);
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
    const loader = new GLTFLoader();
    loader.load(CONFIG.finalModelUrl, (gltf) => {
        finalModel = gltf.scene;
        finalModel.name = '浮金鱼影终局模型';
        finalModel.visible = false;

        const box = new THREE.Box3().setFromObject(finalModel);
        const size = box.getSize(new THREE.Vector3());
        const center = box.getCenter(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z) || 1;
        const scale = 92 / maxDim;

        finalModel.position.sub(center);
        finalModel.scale.setScalar(scale);
        finalModel.rotation.set(0.08, -1.45, 0.03);
        finalModel.traverse((obj) => {
            if (!obj.isMesh) return;
            obj.castShadow = false;
            obj.receiveShadow = false;
            if (obj.material) {
                obj.material.side = THREE.DoubleSide;
                obj.material.needsUpdate = true;
            }
        });

        scene.add(finalModel);
        if (isFinalModelVisible) showFinalModel();

        if (gltf.animations?.length) {
            finalModelMixer = new THREE.AnimationMixer(finalModel);
            gltf.animations.forEach((clip) => finalModelMixer.clipAction(clip).play());
        }
        console.log('[INFO] 终局 3D 模型加载完成: 浮金鱼影');
    }, undefined, (err) => {
        console.warn('[WARN] 终局 3D 模型加载失败:', CONFIG.finalModelUrl, err);
    });
}

function showFinalModel() {
    isFinalModelVisible = true;
    isBoidsMode = false;
    if (particleSystem) particleSystem.visible = false;
    if (boidsGroup) boidsGroup.visible = false;
    if (finalModel) {
        finalModel.visible = true;
        finalModel.position.y = 0;
        finalModel.rotation.set(0.08, -1.45, 0.03);
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
    if (finalModel) finalModel.visible = false;
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

    isMorphing = true;
    morphProgress = 0;
    uniforms.uTexA.value = textures[currentStage] || textures[0];
    uniforms.uTexB.value = textures[targetIdx];
    uniforms.uMorph.value = 0.0;
    currentStage = targetIdx;
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
    document.getElementById('hint-text').textContent = GESTURE_HINTS[4];
    updateRitualCue(4);
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
        currentPhase = PHASES.RELEASE;
        showFinalModel();
        updateUI();
        updatePhaseIndicator();
        updateGestureProgress(4);
        phaseTransitioning = false;
        const hintEl = document.getElementById('hint-text');
        if (hintEl) hintEl.textContent = '浮金鱼影完成 · 3D 建模已现形';
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
    if (!root || !cue) return;

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
    root.classList.toggle('is-hidden', !forceShow);
}

// ═══════════════════════════════════════════════════════
// 页面阶段管理
// ═══════════════════════════════════════════════════════
let fishShadowTime = 0;
let fishEmergProgress = 0;
let fishShadowOpacity = 0;   // 水下鱼影透明度
let fishAttracted = false;   // 鱼是否被吸引靠近
let fishAttractionTimer = 0; // 鱼影吸引累计时间

function enterPhase(phase) {
    currentPhase = phase;
    phaseTransitioning = true;
    playPhaseSfx(phase);
    if (phase === PHASES.CRAFTING || phase === PHASES.RELEASE) resetRitualTimeout();
    hideFinalModel();
    
    const hintEl = document.getElementById('hint-text');
    const panelBody = document.getElementById('panel-body');
    
    switch (phase) {
        case PHASES.WATER:
            // 水面阶段：隐藏鱼和鱼群，只有水波纹，偶有鱼影
            if (particleSystem) particleSystem.visible = false;
            if (boidsGroup) boidsGroup.visible = false;
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
            // 钓鱼阶段：鱼作为暗影出现在水下
            if (particleSystem) {
                particleSystem.visible = true;
                particleSystem.scale.set(0.15, 0.15, 0.15);
                particleSystem.position.set(0, -80, 0);
            }
            if (boidsGroup) boidsGroup.visible = false;
            fishEmergProgress = 0;
            fishAttracted = false;
            if (hintEl) hintEl.textContent = '水下有鱼影在游动...';
            updateRitualCue('fishing');
            break;
            
        case PHASES.CRAFTING:
            // 制灯阶段：正常粒子鱼+形态切换
            if (particleSystem) {
                particleSystem.visible = true;
                particleSystem.scale.set(1, 1, 1);
                particleSystem.position.set(0, 0, 0);
                particleSystem.rotation.set(0, 0, 0);
            }
            // 恢复原色（去除钓鱼阶段的暗影染色）
            uniforms.uTintColor.value.set(1, 1, 1);
            uniforms.uTintStrength.value = 0;
            if (boidsGroup) boidsGroup.visible = false;
            isBoidsMode = false;
            if (panelBody) panelBody.style.display = '';
            if (hintEl) hintEl.textContent = GESTURE_HINTS[0];
            updateRitualCue(0);
            controls.autoRotate = true;
            // 显示制灯进度指示器
            { const gp = document.getElementById('gesture-progress'); if (gp) gp.style.display = 'flex'; }
            updateGestureProgress(0);
            break;
            
        case PHASES.RELEASE:
            // 终局阶段：显示导入的 3D 浮金鱼影模型
            showFinalModel();
            if (panelBody) panelBody.style.display = '';
            if (hintEl) hintEl.textContent = '浮金鱼影完成 · 3D 建模已现形';
            updateRitualCue('release', false);
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
            if (uniforms && textures[0]) {
                uniforms.uTexA.value = textures[0];
                uniforms.uTexB.value = textures[0];
                uniforms.uMorph.value = 0.0;
            }
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
                    if (hintEl) hintEl.textContent = isFinalModelVisible ? '浮金鱼影完成 · 3D 建模已现形' : GESTURE_HINTS[4];
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
        uniforms.uRelief.value = parseFloat(e.target.value);
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

    // 形态按钮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.getAttribute('data-stage'));
            switchToStage(idx);
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
    // 形态按钮高亮
    document.querySelectorAll('.stage-btn').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.getAttribute('data-stage')) === currentStage);
    });
    updatePhaseIndicator();
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
    if (e.code === 'Digit1') enterPhase(PHASES.WATER);
    if (e.code === 'Digit2') enterPhase(PHASES.FISHING);
    if (e.code === 'Digit3') enterPhase(PHASES.CRAFTING);
    if (e.code === 'Digit4') enterPhase(PHASES.RELEASE);
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
// 动画循环
// ═══════════════════════════════════════════════════════
function animate() {
    requestAnimationFrame(animate);

    const dt = clock.getDelta();
    const time = clock.getElapsedTime();

    // 更新 uniforms
    uniforms.uTime.value = time;
    if (finalModelMixer) finalModelMixer.update(dt);
    if (isFinalModelVisible && finalModel) {
        finalModel.rotation.y += dt * 0.18;
        finalModel.position.y = Math.sin(time * 0.9) * 4;
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
    
    if (currentPhase === PHASES.FISHING && particleSystem) {
        // 钓鱼阶段：鱼作为暗影在水下左右摇摆、缓慢靠近
        fishEmergProgress += dt * 0.15; // 很慢地浮出
        const t = Math.min(fishEmergProgress, 1.0);
        const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        
        // 鱼影从水底慢慢浮起 (-80 → -40)，不完全出水
        particleSystem.scale.setScalar(0.2 + ease * 0.45);
        particleSystem.position.y = -80 + ease * 40;
        
        // 左右摇摆游动
        particleSystem.position.x = Math.sin(time * 1.2) * (30 - ease * 15);
        // 轻微旋转模拟鱼摆尾
        particleSystem.rotation.z = Math.sin(time * 2.5) * 0.12;
        particleSystem.rotation.y = Math.sin(time * 1.2) * 0.2;
        
        // 若有手势，鱼游向手掌方向（被吸引）
        if (handData.detected) {
            const tx = -handData.palmX * 40;
            particleSystem.position.x += (tx - particleSystem.position.x) * 0.02;
        }
        
        // 低透明度 = 水下暗影效果（通过 tint 实现）
        uniforms.uTintColor.value.set(0.15, 0.25, 0.4); // 深蓝暗影色
        uniforms.uTintStrength.value = 1.0 - ease * 0.6; // 越靠近越清晰
        
        // 更新提示
        if (ease > 0.6) {
            const hintEl = document.getElementById('hint-text');
            if (hintEl) hintEl.textContent = '✨ 鱼靠近了！捏合手指抓住它！';
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
            ritualTimeoutTimer += dt;
            const limit = RITUAL_TIMEOUTS[4] ?? 0;
            if (limit > 0 && ritualTimeoutTimer >= limit) {
                ritualTimeoutTimer = 0;
                triggerRitualGesture('release');
            }
        }
    }

    // 形态变形进度
    if (isMorphing) {
        morphProgress += dt / CONFIG.morphDuration;
        if (morphProgress >= 1.0) {
            morphProgress = 1.0;
            isMorphing = false;
            // morph 结束后，A 变成 B
            uniforms.uTexA.value = uniforms.uTexB.value;
            uniforms.uMorph.value = 0.0;
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
    
    // 渲染顺序：先水波纹背景（屏幕空间），再3D场景叠加
    if (rippleScene && rippleCamera) {
        renderer.autoClear = true;
        renderer.render(rippleScene, rippleCamera);
        renderer.autoClear = false;
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
