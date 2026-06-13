import './styles.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { loadStepWithOpenCascade } from './occtPipeline.js';

const STORAGE_KEY = 'step-draft:last-step-file';

const canvas = document.querySelector('#viewer');
const uploadInput = document.querySelector('#step-upload');
const draftAngleInput = document.querySelector('#draft-angle');
const downloadSplitStepButton = document.querySelector('#download-split-step');
const clearButton = document.querySelector('#clear-model');
const statusEl = document.querySelector('#status');
const emptyState = document.querySelector('#empty-state');

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242a);
scene.up.set(0, 0, 1);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100000);
camera.up.set(0, 0, 1);
camera.position.set(180, -220, 140);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: false
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

const modelRoot = new THREE.Group();
scene.add(modelRoot);

const grid = new THREE.GridHelper(300, 30, 0x5d646c, 0x3b4148);
grid.rotation.x = Math.PI / 2;
grid.position.z = -0.01;
scene.add(grid);

const hemiLight = new THREE.HemisphereLight(0xffffff, 0x525960, 2.4);
scene.add(hemiLight);

const keyLight = new THREE.DirectionalLight(0xffffff, 2.8);
keyLight.position.set(240, -180, 320);
scene.add(keyLight);

const fillLight = new THREE.DirectionalLight(0xb7d6ff, 0.7);
fillLight.position.set(-180, 120, 90);
scene.add(fillLight);

let currentModel = null;
let draftAnalysisVersion = 0;

function setStatus(message) {
  statusEl.textContent = message;
}

function updateDownloadButton() {
  downloadSplitStepButton.disabled = !currentModel?.splitStepText;
}

function clearModel() {
  modelRoot.clear();
  emptyState.classList.remove('is-hidden');
  updateDownloadButton();
}

function resizeRenderer() {
  const { clientWidth, clientHeight } = canvas;
  const needsResize = canvas.width !== clientWidth || canvas.height !== clientHeight;

  if (needsResize) {
    renderer.setSize(clientWidth, clientHeight, false);
    camera.aspect = clientWidth / Math.max(clientHeight, 1);
    camera.updateProjectionMatrix();
  }
}

function animate() {
  resizeRenderer();
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes.buffer;
}

function saveStepFile(fileName, buffer) {
  const payload = {
    fileName,
    savedAt: new Date().toISOString(),
    data: arrayBufferToBase64(buffer)
  };

  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function getSavedStepFile() {
  const raw = localStorage.getItem(STORAGE_KEY);

  if (!raw) {
    return null;
  }

  try {
    const payload = JSON.parse(raw);
    return {
      fileName: payload.fileName || 'saved-model.step',
      buffer: base64ToArrayBuffer(payload.data)
    };
  } catch (error) {
    localStorage.removeItem(STORAGE_KEY);
    console.warn('Removed unreadable saved STEP file.', error);
    return null;
  }
}

function splitStepFileName(fileName) {
  const withoutExtension = fileName.replace(/\.(step|stp)$/i, '');
  return `${withoutExtension || 'model'}-split.step`;
}

function downloadTextFile(fileName, text) {
  const blob = new Blob([text], {
    type: 'model/step'
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');

  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function normalizeColor(color) {
  if (!color) {
    return new THREE.Color(0.78, 0.8, 0.82);
  }

  if (Array.isArray(color)) {
    return new THREE.Color(color[0] ?? 0.78, color[1] ?? 0.8, color[2] ?? 0.82);
  }

  return new THREE.Color(color.r ?? 0.78, color.g ?? 0.8, color.b ?? 0.82);
}

function getDraftAngle() {
  const value = Number.parseFloat(draftAngleInput.value);

  if (!Number.isFinite(value)) {
    return 3;
  }

  return Math.min(Math.max(value, 0), 89);
}

function failsNormalRule(nz, draftAngleDegrees) {
  if (nz < 0) {
    return true;
  }

  const draftFromVertical = (Math.asin(Math.min(Math.max(Math.abs(nz), 0), 1)) * 180) / Math.PI;
  return draftFromVertical < draftAngleDegrees;
}

function makeMeshGeometry(mesh) {
  const geometry = new THREE.BufferGeometry();
  const position = mesh.attributes?.position?.array || mesh.position || mesh.positions;
  const normal = mesh.attributes?.normal?.array || mesh.normal || mesh.normals;
  const index = mesh.index?.array || mesh.indices || mesh.triangles;

  if (!position) {
    throw new Error(`Mesh "${mesh.name || 'unnamed'}" has no vertex positions.`);
  }

  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));

  if (normal) {
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  } else {
    throw new Error(`Mesh "${mesh.name || 'unnamed'}" has no OCCT analytic normals.`);
  }

  if (index) {
    geometry.setIndex(Array.from(index));
  }

  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();

  return geometry;
}

function makeFailedTriangleGeometry(geometry, draftAngleDegrees) {
  const position = geometry.getAttribute('position');
  const index = geometry.getIndex();

  if (!position || !index) {
    return null;
  }

  const failedPositions = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const ab = new THREE.Vector3();
  const ac = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let item = 0; item + 2 < index.count; item += 3) {
    const ai = index.getX(item);
    const bi = index.getX(item + 1);
    const ci = index.getX(item + 2);

    a.fromBufferAttribute(position, ai);
    b.fromBufferAttribute(position, bi);
    c.fromBufferAttribute(position, ci);
    ab.subVectors(b, a);
    ac.subVectors(c, a);
    normal.crossVectors(ab, ac);

    if (normal.lengthSq() <= 1e-18) {
      continue;
    }

    normal.normalize();

    if (!failsNormalRule(normal.z, draftAngleDegrees)) {
      continue;
    }

    failedPositions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  }

  if (failedPositions.length === 0) {
    return null;
  }

  const failedGeometry = new THREE.BufferGeometry();
  failedGeometry.setAttribute('position', new THREE.Float32BufferAttribute(failedPositions, 3));
  failedGeometry.computeVertexNormals();
  return failedGeometry;
}

function makeFaceMaterials(mesh, brepFaces, failedFaceIndices, mixedFaceIndices, faceIndexOffset) {
  const defaultColor = normalizeColor(mesh.color);
  return brepFaces.map((face, localFaceIndex) => {
    const globalFaceIndex = renderedFaceIndex(face, localFaceIndex, faceIndexOffset);
    let color = normalizeColor(face.color || defaultColor);

    if (failedFaceIndices.has(globalFaceIndex)) {
      color = new THREE.Color(0xd92d20);
    } else if (mixedFaceIndices.has(globalFaceIndex)) {
      color = new THREE.Color(0xf57900);
    }

    return new THREE.MeshStandardMaterial({
      color,
      roughness: 0.58,
      metalness: 0.02,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: 1,
      polygonOffsetUnits: 1
    });
  });
}

function renderedFaceIndex(face, localFaceIndex, faceIndexOffset) {
  return Number.isInteger(face.faceIndex) ? face.faceIndex : faceIndexOffset + localFaceIndex;
}

function makeBoundaryGeometryFromOcctEdges(mesh) {
  if (!mesh.edgePositions || mesh.edgePositions.length === 0) {
    return null;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(mesh.edgePositions, 3));
  return geometry;
}

function addMeshToScene(mesh, failedFaceIndices, mixedFaceIndices, faceIndexOffset) {
  const geometry = makeMeshGeometry(mesh);
  const brepFaces = mesh.brep_faces || mesh.brepFaces || [];
  const materials = makeFaceMaterials(mesh, brepFaces, failedFaceIndices, mixedFaceIndices, faceIndexOffset);

  geometry.clearGroups();
  brepFaces.forEach((face, materialIndex) => {
    geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, materialIndex);
  });

  const solid = new THREE.Mesh(geometry, materials);
  solid.name = mesh.name || 'STEP body';
  modelRoot.add(solid);

  const failedTriangleGeometry = makeFailedTriangleGeometry(geometry, getDraftAngle());
  const failedTriangleCount = failedTriangleGeometry ? failedTriangleGeometry.getAttribute('position').count / 3 : 0;

  if (failedTriangleGeometry) {
    const failedTriangleMaterial = new THREE.MeshStandardMaterial({
      color: 0xd92d20,
      transparent: true,
      opacity: 0.42,
      roughness: 0.58,
      metalness: 0.02,
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2
    });
    const failedTriangles = new THREE.Mesh(failedTriangleGeometry, failedTriangleMaterial);
    failedTriangles.name = `${solid.name} failed triangle normals`;
    modelRoot.add(failedTriangles);
  }

  const edgeGeometry = makeBoundaryGeometryFromOcctEdges(mesh);
  if (!edgeGeometry) {
    return {
      boundarySegments: 0,
      failedTriangles: failedTriangleCount,
      failedFaces: brepFaces.filter((face, localFaceIndex) => failedFaceIndices.has(renderedFaceIndex(face, localFaceIndex, faceIndexOffset))).length,
      mixedFaces: brepFaces.filter((face, localFaceIndex) => mixedFaceIndices.has(renderedFaceIndex(face, localFaceIndex, faceIndexOffset))).length,
      totalFaces: brepFaces.length
    };
  }

  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0x101318,
    transparent: true,
    opacity: 0.82,
    depthTest: true
  });
  const edges = new THREE.LineSegments(edgeGeometry, edgeMaterial);
  edges.name = `${solid.name} boundaries`;
  modelRoot.add(edges);
  return {
    boundarySegments: edgeGeometry.getAttribute('position').count / 2,
    failedTriangles: failedTriangleCount,
    failedFaces: brepFaces.filter((face, localFaceIndex) => failedFaceIndices.has(renderedFaceIndex(face, localFaceIndex, faceIndexOffset))).length,
    mixedFaces: brepFaces.filter((face, localFaceIndex) => mixedFaceIndices.has(renderedFaceIndex(face, localFaceIndex, faceIndexOffset))).length,
    totalFaces: brepFaces.length
  };
}

function frameModel() {
  const box = new THREE.Box3().setFromObject(modelRoot);

  if (box.isEmpty()) {
    return;
  }

  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z) * 0.72 || 100;
  const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov * 0.5));

  controls.target.copy(center);
  camera.near = Math.max(distance / 1000, 0.01);
  camera.far = Math.max(distance * 10, 1000);
  camera.position.copy(center).add(new THREE.Vector3(distance, -distance, distance * 0.65));
  camera.updateProjectionMatrix();
  controls.update();

  grid.position.z = box.min.z;
  grid.scale.setScalar(Math.max(Math.ceil(Math.max(size.x, size.y) / 300), 1));
}

function renderLoadedModel({ frame = true } = {}) {
  if (!currentModel) {
    return;
  }

  clearModel();
  let faceIndexOffset = 0;
  const stats = currentModel.meshes.reduce(
    (total, mesh) => {
      const meshStats = addMeshToScene(mesh, currentModel.failedFaceIndices, currentModel.mixedFaceIndices, faceIndexOffset);
      faceIndexOffset += meshStats.totalFaces;
      total.boundarySegments += meshStats.boundarySegments;
      total.failedTriangles += meshStats.failedTriangles;
      total.failedFaces += meshStats.failedFaces;
      total.mixedFaces += meshStats.mixedFaces;
      total.totalFaces += meshStats.totalFaces;
      return total;
    },
    { boundarySegments: 0, failedTriangles: 0, failedFaces: 0, mixedFaces: 0, totalFaces: 0 }
  );

  if (frame) {
    frameModel();
  }

  emptyState.classList.add('is-hidden');
  const splitSummary = summarizeSplitDiagnostics(currentModel.splitDiagnostics);

  if (currentModel.splitDiagnostics) {
    console.info('OCCT split diagnostics', currentModel.splitDiagnostics);
  }

  setStatus(
    `Loaded ${currentModel.fileName} - ${stats.failedTriangles} failed diagnostic triangles, ${stats.totalFaces} OCCT faces, ${stats.boundarySegments} BRep boundary segments${splitSummary}`
  );
}

function summarizeSplitDiagnostics(diagnostics) {
  if (!diagnostics?.totals) {
    return '';
  }

  const parts = Object.entries(diagnostics.totals)
    .filter(([, value]) => value.splitSurfaces > 0 || value.failedCandidates > 0 || value.successfulSplits > 0)
    .map(([surfaceType, value]) => `${surfaceType}: ${value.successfulSplits}/${value.faces} split, ${value.sectionEdges} edges, ${value.toolFaces} tools, ${value.failedCandidates} failed`);

  return parts.length > 0 ? `; splits - ${parts.join('; ')}` : '';
}

function progressLabel(progress, fileName) {
  if (!progress?.totalFaces) {
    return `Splitting ${fileName} with OCCT workers...`;
  }

  const last = progress.lastSurfaceType ? `; last ${progress.lastSurfaceType} face ${progress.lastFaceIndex}` : '';
  return `Splitting ${fileName} with ${progress.workers} OCCT workers - ${progress.completedFaces}/${progress.totalFaces} faces, ${progress.replacementFaces} replacements${last}`;
}

async function updateDraftAnalysis() {
  if (!currentModel?.buffer) {
    return;
  }

  const version = (draftAnalysisVersion += 1);
  const draftAngle = getDraftAngle();
  setStatus(`Evaluating analytic OCCT surfaces at ${draftAngle} degrees...`);

  const draftAnalysis = await loadStepWithOpenCascade(currentModel.buffer, draftAngle, {
    onInitialModel: (initialModel) => {
      if (version !== draftAnalysisVersion) {
        return;
      }

      currentModel.failedFaceIndices = initialModel.failedFaceIndices;
      currentModel.mixedFaceIndices = initialModel.mixedFaceIndices;
      currentModel.meshes = initialModel.meshes;
      currentModel.splitDiagnostics = initialModel.splitDiagnostics;
      currentModel.analyzedFaceCount = initialModel.totalFaces;
      renderLoadedModel();
    },
    onPartialModel: (partialModel) => {
      if (version !== draftAnalysisVersion) {
        return;
      }

      currentModel.failedFaceIndices = partialModel.failedFaceIndices;
      currentModel.mixedFaceIndices = partialModel.mixedFaceIndices;
      currentModel.meshes = partialModel.meshes;
      currentModel.splitDiagnostics = partialModel.splitDiagnostics;
      currentModel.analyzedFaceCount = partialModel.totalFaces;
      renderLoadedModel({ frame: false });
    },
    onProgress: (progress) => {
      if (version === draftAnalysisVersion) {
        setStatus(progressLabel(progress, currentModel.fileName));
      }
    }
  });

  if (version !== draftAnalysisVersion) {
    return;
  }

  currentModel.failedFaceIndices = draftAnalysis.failedFaceIndices;
  currentModel.mixedFaceIndices = draftAnalysis.mixedFaceIndices;
  currentModel.meshes = draftAnalysis.meshes;
  currentModel.splitDiagnostics = draftAnalysis.splitDiagnostics;
  currentModel.splitStepText = draftAnalysis.splitStepText;
  currentModel.analyzedFaceCount = draftAnalysis.totalFaces;
  renderLoadedModel();
}

async function loadStepBuffer(buffer, fileName) {
  clearModel();
  setStatus(`Loading ${fileName} with OpenCascade...`);

  currentModel = {
    fileName,
    buffer,
    meshes: [],
    failedFaceIndices: new Set(),
    mixedFaceIndices: new Set(),
    splitStepText: null,
    splitDiagnostics: null,
    analyzedFaceCount: 0
  };

  const result = await loadStepWithOpenCascade(buffer, getDraftAngle(), {
    onInitialModel: (initialModel) => {
      currentModel.meshes = initialModel.meshes;
      currentModel.failedFaceIndices = initialModel.failedFaceIndices;
      currentModel.mixedFaceIndices = initialModel.mixedFaceIndices;
      currentModel.splitDiagnostics = initialModel.splitDiagnostics;
      currentModel.analyzedFaceCount = initialModel.totalFaces;
      renderLoadedModel();
    },
    onPartialModel: (partialModel) => {
      currentModel.meshes = partialModel.meshes;
      currentModel.failedFaceIndices = partialModel.failedFaceIndices;
      currentModel.mixedFaceIndices = partialModel.mixedFaceIndices;
      currentModel.splitDiagnostics = partialModel.splitDiagnostics;
      currentModel.analyzedFaceCount = partialModel.totalFaces;
      renderLoadedModel({ frame: false });
    },
    onProgress: (progress) => {
      setStatus(progressLabel(progress, fileName));
    }
  });
  const meshes = result.meshes || [];

  currentModel = {
    fileName,
    buffer,
    meshes,
    failedFaceIndices: result.failedFaceIndices,
    mixedFaceIndices: result.mixedFaceIndices,
    splitStepText: result.splitStepText,
    splitDiagnostics: result.splitDiagnostics,
    analyzedFaceCount: result.totalFaces
  };
  renderLoadedModel();
}

uploadInput.addEventListener('change', async (event) => {
  const [file] = event.target.files;

  if (!file) {
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    saveStepFile(file.name, buffer);
    await loadStepBuffer(buffer, file.name);
  } catch (error) {
    console.error(error);
    setStatus(error.message);
  } finally {
    uploadInput.value = '';
  }
});

clearButton.addEventListener('click', () => {
  localStorage.removeItem(STORAGE_KEY);
  currentModel = null;
  clearModel();
  setStatus('Cleared saved STEP file');
});

downloadSplitStepButton.addEventListener('click', () => {
  if (!currentModel?.splitStepText) {
    return;
  }

  downloadTextFile(splitStepFileName(currentModel.fileName), currentModel.splitStepText);
});

draftAngleInput.addEventListener('input', () => {
  updateDraftAnalysis().catch((error) => {
    console.error(error);
    setStatus(error.message);
  });
});

const savedFile = getSavedStepFile();

if (savedFile) {
  loadStepBuffer(savedFile.buffer, savedFile.fileName).catch((error) => {
    console.error(error);
    setStatus(error.message);
  });
}

animate();
