/**
 * GLB → 点云采样模块
 * 从 GLB 模型表面采样指定数量的点，返回 DataTexture 用于 GPU 粒子 morph
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshSurfaceSampler } from 'three/addons/math/MeshSurfaceSampler.js';

// 5 种鱼的 GLB 配置
export const FISH_TYPES = [
    { name: '浮金鱼', fish: 'assets/models/浮金鱼影.glb', lantern: 'assets/models/浮金鱼灯.glb' },
    { name: '狮子头', fish: 'assets/models/狮子头鱼之影.glb', lantern: 'assets/models/狮子头鱼灯.glb' },
    { name: '石斑鱼', fish: 'assets/models/石斑之影.glb', lantern: 'assets/models/石斑鱼灯.glb' },
    { name: '红鲤鱼', fish: 'assets/models/红鲤之影.glb', lantern: 'assets/models/红鲤鱼灯.glb' },
    { name: '鲮鱼',   fish: 'assets/models/鲮鱼之影.glb', lantern: 'assets/models/鲮鱼鱼灯.glb' },
];

const gltfLoader = new GLTFLoader();

/**
 * 加载 GLB 并合并为单个 BufferGeometry
 */
function loadGLB(url) {
    return new Promise((resolve, reject) => {
        gltfLoader.load(url, (gltf) => {
            const meshes = [];
            gltf.scene.updateMatrixWorld(true);
            gltf.scene.traverse((obj) => {
                if (obj.isMesh) meshes.push(obj);
            });
            if (meshes.length === 0) {
                reject(new Error(`[ERROR] GLB 无网格: ${url}`));
                return;
            }
            // 合并为单个 mesh（处理多子网格情况）
            if (meshes.length === 1) {
                resolve(meshes[0]);
            } else {
                // 合并所有 mesh 的几何体
                const merged = new THREE.Mesh(
                    mergeGeometries(meshes),
                    meshes[0].material
                );
                resolve(merged);
            }
        }, undefined, (err) => reject(err));
    });
}

/**
 * 简单合并多个 mesh 的几何体
 */
function mergeGeometries(meshes) {
    const positions = [];
    const normals = [];
    const colors = [];
    let hasColors = false;

    for (const mesh of meshes) {
        const geo = mesh.geometry.clone();
        geo.applyMatrix4(mesh.matrixWorld);
        const pos = geo.attributes.position;
        const nor = geo.attributes.normal;
        const col = geo.attributes.color;

        for (let i = 0; i < pos.count; i++) {
            positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
            if (nor) normals.push(nor.getX(i), nor.getY(i), nor.getZ(i));
            if (col) {
                colors.push(col.getX(i), col.getY(i), col.getZ(i));
                hasColors = true;
            }
        }

        if (geo.index) {
            // 处理索引几何体 - 这里简化处理，直接用非索引版
        }
    }

    const merged = new THREE.BufferGeometry();
    merged.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    if (normals.length) merged.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    if (hasColors) merged.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    return merged;
}

/**
 * 将材质纹理 bake 到顶点颜色（供 MeshSurfaceSampler 插值）
 */
function bakeTextureToVertexColors(mesh) {
    const geo = mesh.geometry;
    const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const tex = mat?.map;
    const uvAttr = geo.attributes.uv;

    console.log('[DEBUG] bake尝试:', { hasMat: !!mat, hasMap: !!tex, hasUV: !!uvAttr, hasImage: !!tex?.image });
    if (!window.__bakeDebug) window.__bakeDebug = [];
    window.__bakeDebug.push({ hasMat: !!mat, hasMap: !!tex, hasUV: !!uvAttr, hasImage: !!tex?.image, matType: mat?.type, mapType: tex?.constructor?.name });

    if (!tex || !uvAttr || !tex.image) {
        console.warn('[WARN] 纹理bake失败: 缺少材质纹理或UV');
        return false;
    }

    const img = tex.image;
    const canvas = document.createElement('canvas');
    const w = img.width || img.naturalWidth || 256;
    const h = img.height || img.naturalHeight || 256;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const imageData = ctx.getImageData(0, 0, w, h);
    const pixels = imageData.data;

    const count = uvAttr.count;
    const colorsArr = new Float32Array(count * 3);

    for (let i = 0; i < count; i++) {
        const u = uvAttr.getX(i);
        const v = uvAttr.getY(i);
        // UV → pixel（注意 V 翻转：UV 的 v=0 在底部，canvas 的 y=0 在顶部）
        const px = Math.min(Math.max(Math.floor(u * w), 0), w - 1);
        const py = Math.min(Math.max(Math.floor((1 - v) * h), 0), h - 1);
        const idx = (py * w + px) * 4;
        colorsArr[i * 3]     = pixels[idx] / 255;
        colorsArr[i * 3 + 1] = pixels[idx + 1] / 255;
        colorsArr[i * 3 + 2] = pixels[idx + 2] / 255;
    }

    geo.setAttribute('color', new THREE.Float32BufferAttribute(colorsArr, 3));
    // 存储调试信息
    if (!window.__bakeColors) window.__bakeColors = [];
    window.__bakeColors.push(Array.from(colorsArr.slice(0, 15)).map(v => v.toFixed(3)));
    console.log('[INFO] 纹理bake成功:', count, '个顶点, 前5色值:', 
        Array.from(colorsArr.slice(0, 15)).map(v => v.toFixed(2)));
    return true;
}

/**
 * 从 mesh 表面采样 N 个点，返回 { positions, colors }
 * @param {THREE.Mesh} mesh
 * @param {number} count - 采样点数
 * @param {number} scale - 缩放到多大的包围盒（单位：世界坐标）
 * @returns {{ positions: Float32Array, colors: Float32Array }}
 */
function sampleSurface(mesh, count, scale = 90) {
    // 归一化模型到原点 + 统一缩放
    const geo = mesh.geometry;
    geo.computeBoundingBox();
    const box = geo.boundingBox;
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 1;
    const s = scale / maxDim;

    // 获取材质颜色作为默认颜色
    let defaultColor = new THREE.Color(0.85, 0.65, 0.25); // 金色默认
    if (mesh.material) {
        const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
        if (mat.color) defaultColor = mat.color.clone();
    }

    // 尝试把材质纹理 bake 到顶点颜色
    const hasBakedColor = bakeTextureToVertexColors(mesh);

    // 确保有 normal（采样器需要）
    if (!geo.attributes.normal) geo.computeVertexNormals();

    const sampler = new MeshSurfaceSampler(mesh).build();

    const positions = new Float32Array(count * 4); // xyzw, w=1 表示有效点
    const colors = new Float32Array(count * 4);    // rgba

    const _pos = new THREE.Vector3();
    const _nor = new THREE.Vector3();
    const _col = new THREE.Color();

    for (let i = 0; i < count; i++) {
        sampler.sample(_pos, _nor, _col);

        // 居中 + 缩放
        positions[i * 4]     = (_pos.x - center.x) * s;
        positions[i * 4 + 1] = (_pos.y - center.y) * s;
        positions[i * 4 + 2] = (_pos.z - center.z) * s;
        positions[i * 4 + 3] = 1.0; // 有效标记

        if (hasBakedColor) {
            // 使用采样器插值出的 baked 颜色
            colors[i * 4]     = _col.r;
            colors[i * 4 + 1] = _col.g;
            colors[i * 4 + 2] = _col.b;
        } else {
            // 默认金色 + 简单光照
            const lightDir = new THREE.Vector3(0.5, 0.8, 0.3).normalize();
            const ndotl = Math.max(0.3, _nor.dot(lightDir));
            colors[i * 4]     = defaultColor.r * ndotl;
            colors[i * 4 + 1] = defaultColor.g * ndotl;
            colors[i * 4 + 2] = defaultColor.b * ndotl;
        }
        colors[i * 4 + 3] = 1.0;
    }

    // 调试：记录采样颜色
    if (!window.__sampleDebug) window.__sampleDebug = [];
    const first5 = Array.from(colors.slice(0, 20)).map(v => v.toFixed(3));
    window.__sampleDebug.push({ hasBakedColor, first5Colors: first5, hasColorAttr: !!geo.attributes.color });

    return { positions, colors };
}

// 存储采样调试信息
if (!window.__sampleDebug) window.__sampleDebug = [];

/**
 * 将采样数据打包为 DataTexture（用于 GPU 读取）
 * @param {Float32Array} data - RGBA float 数据
 * @param {number} texSize - 纹理尺寸（texSize × texSize）
 * @returns {THREE.DataTexture}
 */
function createDataTexture(data, texSize) {
    const tex = new THREE.DataTexture(
        data,
        texSize, texSize,
        THREE.RGBAFormat,
        THREE.FloatType
    );
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
}

/**
 * 加载一个 GLB 并采样为点云数据纹理
 * @param {string} url - GLB 路径
 * @param {number} texSize - 纹理尺寸（点数 = texSize²）
 * @param {number} scale - 模型缩放尺寸
 * @returns {Promise<{ posTex: THREE.DataTexture, colTex: THREE.DataTexture }>}
 */
export async function sampleGLB(url, texSize = 128, scale = 90) {
    const mesh = await loadGLB(url);
    const count = texSize * texSize;
    const { positions, colors } = sampleSurface(mesh, count, scale);
    return {
        posTex: createDataTexture(positions, texSize),
        colTex: createDataTexture(colors, texSize),
    };
}

/**
 * 预加载一种鱼的全部点云数据（鱼影 + 鱼灯）
 * @param {number} fishIndex - FISH_TYPES 索引
 * @param {number} texSize
 * @param {number} scale
 * @returns {Promise<{ fish: {posTex, colTex}, lantern: {posTex, colTex} }>}
 */
export async function loadFishPointClouds(fishIndex, texSize = 128, scale = 90) {
    const fishType = FISH_TYPES[fishIndex];
    if (!fishType) throw new Error(`[ERROR] 无效鱼种索引: ${fishIndex}`);

    console.log(`[INFO] 开始采样点云: ${fishType.name}`);

    const [fish, lantern] = await Promise.all([
        sampleGLB(fishType.fish, texSize, scale),
        sampleGLB(fishType.lantern, texSize, scale),
    ]);

    console.log(`[INFO] 点云采样完成: ${fishType.name} (${texSize}×${texSize} = ${texSize * texSize} 粒子)`);

    return { fish, lantern };
}

/**
 * 预加载所有鱼种的点云数据
 * @param {number} texSize
 * @param {number} scale
 * @param {function} onProgress - (loaded, total) => void
 * @returns {Promise<Array<{ fish: {posTex, colTex}, lantern: {posTex, colTex} }>>}
 */
export async function loadAllFishPointClouds(texSize = 128, scale = 90, onProgress = null) {
    const results = [];
    for (let i = 0; i < FISH_TYPES.length; i++) {
        const data = await loadFishPointClouds(i, texSize, scale);
        results.push(data);
        if (onProgress) onProgress(i + 1, FISH_TYPES.length);
    }
    return results;
}

/**
 * 加载 GLB 为可直接渲染的 THREE.Group（网格模式）
 * @param {string} url - GLB 路径
 * @param {number} scale - 统一缩放到的包围盒尺寸
 * @returns {Promise<THREE.Group>}
 */
export function loadGLBMesh(url, scale = 90) {
    return new Promise((resolve, reject) => {
        gltfLoader.load(url, (gltf) => {
            const group = gltf.scene;
            // 计算包围盒 → 居中 + 缩放
            const box = new THREE.Box3().setFromObject(group);
            const size = box.getSize(new THREE.Vector3());
            const center = box.getCenter(new THREE.Vector3());
            const maxDim = Math.max(size.x, size.y, size.z) || 1;
            const s = scale / maxDim;
            group.position.sub(center.multiplyScalar(s));
            group.scale.setScalar(s);
            // 材质优化
            group.traverse((obj) => {
                if (!obj.isMesh) return;
                if (obj.material) {
                    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                    mats.forEach(mat => {
                        mat.side = THREE.DoubleSide;
                        mat.needsUpdate = true;
                    });
                }
            });
            resolve(group);
        }, undefined, reject);
    });
}

/**
 * 将 GLB 模型渲染为 2D 纹理图片（正面视角）
 * @param {string} url - GLB 路径
 * @param {number} resolution - 渲染分辨率（正方形）
 * @param {object} options - { bgColor, cameraFov, scale }
 * @returns {Promise<THREE.Texture>} 渲染后的纹理
 */
export async function renderGLBToTexture(url, resolution = 512, options = {}) {
    const { bgColor = 0x000000, cameraFov = 35, scale = 90 } = options;
    
    // 创建离屏渲染目标
    const renderTarget = new THREE.WebGLRenderTarget(resolution, resolution, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
        minFilter: THREE.LinearFilter,
        magFilter: THREE.LinearFilter,
    });
    
    // 创建临时场景
    const tempScene = new THREE.Scene();
    tempScene.background = new THREE.Color(bgColor);
    
    // 灯光
    const ambLight = new THREE.AmbientLight(0xffffff, 0.6);
    tempScene.add(ambLight);
    const keyLight = new THREE.DirectionalLight(0xfff0d0, 1.8);
    keyLight.position.set(2, 3, 4);
    tempScene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x88ccff, 0.8);
    rimLight.position.set(-3, 1, -2);
    tempScene.add(rimLight);
    
    // 加载模型
    const group = await loadGLBMesh(url, scale);
    tempScene.add(group);
    
    // 相机设置（正面略偏，展示鱼的最佳角度）
    const camera = new THREE.PerspectiveCamera(cameraFov, 1, 0.1, 1000);
    camera.position.set(0, 10, 160);
    camera.lookAt(0, 0, 0);
    
    // 使用页面上已有的 renderer（避免创建新 GL context）
    // 需要外部传入 renderer
    return { renderTarget, tempScene, camera, group };
}

/**
 * 用已有 renderer 渲染 GLB 到纹理，返回 ImageData
 * @param {THREE.WebGLRenderer} renderer
 * @param {string} url - GLB 路径
 * @param {number} resolution
 * @returns {Promise<THREE.Texture>}
 */
export async function captureGLBAsTexture(renderer, url, resolution = 256) {
    const renderTarget = new THREE.WebGLRenderTarget(resolution, resolution, {
        format: THREE.RGBAFormat,
        type: THREE.UnsignedByteType,
    });
    
    // 临时场景
    const tempScene = new THREE.Scene();
    tempScene.background = new THREE.Color(0x000000);
    
    // 灯光
    tempScene.add(new THREE.AmbientLight(0xffffff, 0.6));
    const key = new THREE.DirectionalLight(0xfff5e0, 2.5);
    key.position.set(2, 3, 4);
    tempScene.add(key);
    const rim = new THREE.DirectionalLight(0x80c8ff, 1.2);
    rim.position.set(-3, 1, -2);
    tempScene.add(rim);
    
    // 加载模型
    const group = await loadGLBMesh(url, 80);
    tempScene.add(group);
    
    // 正交相机（确保模型填满画面）
    const halfSize = 50;
    const cam = new THREE.OrthographicCamera(-halfSize, halfSize, halfSize, -halfSize, 0.1, 500);
    cam.position.set(0, 5, 120);
    cam.lookAt(0, 0, 0);
    
    // 渲染
    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(renderTarget);
    renderer.render(tempScene, cam);
    renderer.setRenderTarget(prevRT);
    
    // 读取像素
    const pixels = new Uint8Array(resolution * resolution * 4);
    renderer.readRenderTargetPixels(renderTarget, 0, 0, resolution, resolution, pixels);
    
    // 转换为普通纹理（翻转Y轴，WebGL坐标系Y朝上）
    const flipped = new Uint8Array(resolution * resolution * 4);
    for (let y = 0; y < resolution; y++) {
        const srcRow = (resolution - 1 - y) * resolution * 4;
        const dstRow = y * resolution * 4;
        flipped.set(pixels.subarray(srcRow, srcRow + resolution * 4), dstRow);
    }
    
    const texture = new THREE.DataTexture(flipped, resolution, resolution, THREE.RGBAFormat);
    texture.needsUpdate = true;
    
    // 清理
    renderTarget.dispose();
    tempScene.clear();
    
    return texture;
}
