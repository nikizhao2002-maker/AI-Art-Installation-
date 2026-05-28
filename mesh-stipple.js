/**
 * 网格粒子化材质 (Mesh Stipple Shader)
 * 用 fragment shader 在网格表面创建点阵效果
 * 看起来像点云，但实际是渲染完整网格 → 100% 覆盖率
 */
import * as THREE from 'three';

// 粒子化 Vertex Shader
const stippleVertexShader = /* glsl */`
    uniform float uTime;
    uniform float uSwimAmp;

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    varying vec3 vViewPos;

    void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);

        // 游动动画
        vec3 pos = position;
        float phase = uTime * 2.0;

        // S 形身体摆动（沿模型局部 X 轴）
        float bodyWave = sin(pos.x * 0.05 + phase) * uSwimAmp * 2.0;
        pos.z += bodyWave;

        // 尾部增强摆动
        float tailFactor = smoothstep(0.0, 1.0, pos.x * 0.02);
        pos.z += sin(phase * 1.5) * tailFactor * uSwimAmp * 4.0;

        // 上下浮动
        pos.y += sin(uTime * 0.8) * uSwimAmp * 0.5;

        vec4 mvPos = modelViewMatrix * vec4(pos, 1.0);
        vViewPos = mvPos.xyz;
        vWorldPos = (modelMatrix * vec4(pos, 1.0)).xyz;
        gl_Position = projectionMatrix * mvPos;
    }
`;

// 粒子化 Fragment Shader
const stippleFragmentShader = /* glsl */`
    uniform float uTime;
    uniform float uDotSpacing;    // 点阵间距（像素）
    uniform float uDotRadius;     // 点半径占间距比例 0~0.5
    uniform float uDissolve;      // 溶解度 0=实体 1=完全溶解
    uniform sampler2D uTexture;   // 模型纹理
    uniform vec3 uBaseColor;      // 基础颜色
    uniform float uHasTexture;    // 是否有纹理

    varying vec2 vUv;
    varying vec3 vNormal;
    varying vec3 vWorldPos;
    varying vec3 vViewPos;

    // 伪随机
    float hash21(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }

    void main() {
        // 获取颜色
        vec3 color;
        if (uHasTexture > 0.5) {
            color = texture2D(uTexture, vUv).rgb;
        } else {
            color = uBaseColor;
        }

        // 简单光照
        vec3 lightDir = normalize(vec3(0.5, 0.8, 0.6));
        float ndotl = max(0.4, dot(vNormal, lightDir));
        color *= ndotl;

        // 金色高光
        vec3 gold = vec3(0.85, 0.68, 0.2);
        float luma = dot(color, vec3(0.299, 0.587, 0.114));
        color = mix(color, gold, luma * 0.1);

        // ═══ 屏幕空间点阵 ═══
        vec2 screenPos = gl_FragCoord.xy;
        float spacing = uDotSpacing;

        // 点阵网格坐标
        vec2 cellId = floor(screenPos / spacing);
        vec2 cellPos = mod(screenPos, spacing) - spacing * 0.5;

        // 给每个 cell 一点随机偏移（打破规则感）
        float rnd = hash21(cellId);
        vec2 jitter = (vec2(hash21(cellId + 0.1), hash21(cellId + 0.7)) - 0.5) * spacing * 0.3;
        cellPos -= jitter;

        // 圆形点
        float dist = length(cellPos);
        float radius = spacing * uDotRadius;

        // 溶解效果：基于随机值让部分点消失
        float dissolveThreshold = rnd;
        if (uDissolve > dissolveThreshold) discard;

        // 超出点半径则丢弃
        if (dist > radius) discard;

        // 柔化边缘
        float edgeFade = 1.0 - smoothstep(radius * 0.6, radius, dist);

        // 最终输出
        gl_FragColor = vec4(color, edgeFade * 0.95);
    }
`;

/**
 * 创建粒子化材质
 * @param {object} options
 * @returns {THREE.ShaderMaterial}
 */
export function createStippleMaterial(options = {}) {
    const {
        dotSpacing = 6.0,
        dotRadius = 0.38,
        baseColor = new THREE.Color(0.85, 0.65, 0.25),
        texture = null,
        swimAmp = 3.0,
    } = options;

    const material = new THREE.ShaderMaterial({
        uniforms: {
            uTime: { value: 0 },
            uDotSpacing: { value: dotSpacing },
            uDotRadius: { value: dotRadius },
            uDissolve: { value: 0.0 },
            uTexture: { value: texture || new THREE.Texture() },
            uBaseColor: { value: new THREE.Vector3(baseColor.r, baseColor.g, baseColor.b) },
            uHasTexture: { value: texture ? 1.0 : 0.0 },
            uSwimAmp: { value: swimAmp },
        },
        vertexShader: stippleVertexShader,
        fragmentShader: stippleFragmentShader,
        transparent: true,
        side: THREE.DoubleSide,
        depthWrite: true,
    });

    return material;
}

/**
 * 将 GLB 网格的所有子材质替换为 stipple 材质
 * @param {THREE.Group} group - loadGLBMesh 返回的 group
 * @param {object} options
 * @returns {THREE.ShaderMaterial} 返回材质引用以便后续更新 uniforms
 */
export function applyStippleMaterial(group, options = {}) {
    const material = createStippleMaterial(options);

    group.traverse((obj) => {
        if (!obj.isMesh) return;
        // 如果网格有贴图，传给 stipple shader
        const origMat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
        if (origMat && origMat.map) {
            material.uniforms.uTexture.value = origMat.map;
            material.uniforms.uHasTexture.value = 1.0;
        }
        obj.material = material;
    });

    return material;
}
