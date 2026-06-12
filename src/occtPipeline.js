import initOpenCascade from 'opencascade.js/dist/index.js';
import {
  findConeSplitSurfaces,
  findCylinderSplitSurfaces,
  findSphereSplitSurfaces,
  findTorusSplitSurfaces
} from './findSplitSurface.js';

let openCascadePromise;

export function getOpenCascade() {
  if (!openCascadePromise) {
    openCascadePromise = initOpenCascade();
  }

  return openCascadePromise;
}

function makeInstance(oc, baseName, args = []) {
  for (let suffix = 1; suffix <= 40; suffix += 1) {
    const ctor = oc[`${baseName}_${suffix}`];

    if (!ctor) {
      continue;
    }

    try {
      return new ctor(...args);
    } catch {
      // Try the next overload.
    }
  }

  const ctor = oc[baseName];
  if (ctor) {
    return new ctor(...args);
  }

  throw new Error(`OpenCascade.js does not expose ${baseName}.`);
}

function callAny(target, names, args = []) {
  for (const name of names) {
    const methodNames = [name];

    for (let suffix = 1; suffix <= 40; suffix += 1) {
      methodNames.push(`${name}_${suffix}`);
    }

    for (const methodName of methodNames) {
      if (typeof target?.[methodName] !== 'function') {
        continue;
      }

      try {
        return target[methodName](...args);
      } catch {
        // Try the next overload.
      }
    }
  }

  throw new Error(`OpenCascade.js method missing: ${names.join(', ')}.`);
}

function callAnyArgs(target, names, argLists) {
  const errors = [];

  for (const args of argLists) {
    try {
      return callAny(target, names, args);
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  throw new Error(`OpenCascade.js method missing: ${names.join(', ')}. ${errors.join(' | ')}`);
}

function tryCallAnyArgs(target, names, argLists) {
  try {
    return { called: true, value: callAnyArgs(target, names, argLists) };
  } catch {
    return { called: false, value: undefined };
  }
}

function statusValue(status) {
  if (typeof status === 'number') {
    return status;
  }

  if (typeof status?.value === 'number') {
    return status.value;
  }

  return Number(status);
}

function enumValue(oc, groupName, valueName) {
  return oc[valueName] || oc[groupName]?.[valueName];
}

function dereferenceHandle(value) {
  if (value && typeof value.get === 'function') {
    return value.get();
  }

  return value;
}

function transferReaderRoots(oc, reader) {
  const progress = makeInstance(oc, 'Message_ProgressRange');
  const attempts = [
    () => reader.TransferRoots(progress),
    () => reader.TransferRoot(1, progress),
    () => {
      const rootCount = reader.NbRootsForTransfer();
      let transferred = 0;

      for (let rootIndex = 1; rootIndex <= rootCount; rootIndex += 1) {
        transferred += reader.TransferOneRoot(rootIndex, progress) ? 1 : 0;
      }

      return transferred;
    }
  ];
  const errors = [];

  for (const attempt of attempts) {
    try {
      const transferred = attempt();

      if (typeof transferred === 'number' || typeof transferred === 'boolean') {
        return transferred;
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  throw new Error(`OpenCascade could read the STEP file but could not transfer roots: ${errors.join(' | ')}`);
}

function readStepShape(oc, buffer) {
  const path = `/tmp/model-${Date.now()}.step`;
  oc.FS.writeFile(path, new Uint8Array(buffer));

  if (oc.STEPControl_Controller?.Init) {
    oc.STEPControl_Controller.Init();
  }

  const reader = makeInstance(oc, 'STEPControl_Reader');
  const status = statusValue(callAny(reader, ['ReadFile'], [path]));

  const knownFailureStatuses = new Set([
    2,
    3,
    4
  ]);

  if (knownFailureStatuses.has(status)) {
    throw new Error(`OpenCascade could not read this STEP file. ReadFile status: ${status}`);
  }

  const transferred = transferReaderRoots(oc, reader);
  const shape = callAny(reader, ['OneShape']);

  if (callAny(shape, ['IsNull'])) {
    throw new Error(`OpenCascade read the file but produced an empty shape. ReadFile status: ${status}, transferred roots: ${transferred}`);
  }

  return shape;
}

function writeStepShape(oc, shape) {
  const writer = makeInstance(oc, 'STEPControl_Writer');
  const path = `/tmp/split-model-${Date.now()}.step`;
  const progress = makeInstance(oc, 'Message_ProgressRange');
  const mode = enumValue(oc, 'STEPControl_StepModelType', 'STEPControl_AsIs');
  const enumDoneStatus = statusValue(enumValue(oc, 'IFSelect_ReturnStatus', 'IFSelect_RetDone'));
  const doneStatus = Number.isFinite(enumDoneStatus) ? enumDoneStatus : 1;
  const transferStatus = statusValue(callAny(writer, ['Transfer'], [shape, mode, true, progress]));

  if (transferStatus !== doneStatus) {
    throw new Error(`OpenCascade could not transfer the split shape for STEP export. Transfer status: ${transferStatus}`);
  }

  const writeStatus = statusValue(callAny(writer, ['Write'], [path]));

  if (writeStatus !== doneStatus) {
    throw new Error(`OpenCascade could not write the split STEP file. Write status: ${writeStatus}`);
  }

  return oc.FS.readFile(path, { encoding: 'utf8' });
}

const RENDER_LINEAR_DEFLECTION = 0.025;
const RENDER_ANGULAR_DEFLECTION = 0.15;

function cleanTriangulation(oc, shape) {
  tryCallAnyArgs(oc.BRepTools, ['Clean'], [[shape, true], [shape]]);
}

function triangulateFace(oc, face) {
  const mesher = makeInstance(oc, 'BRepMesh_IncrementalMesh', [
    face,
    RENDER_LINEAR_DEFLECTION,
    false,
    RENDER_ANGULAR_DEFLECTION,
    true
  ]);

  if (typeof mesher.Perform === 'function') {
    mesher.Perform(makeInstance(oc, 'Message_ProgressRange'));
  }
}

function faceFromExplorer(oc, explorer) {
  const shape = callAny(explorer, ['Current']);

  if (oc.TopoDS?.Face_1) {
    return oc.TopoDS.Face_1(shape);
  }

  if (oc.TopoDS?.Face) {
    return oc.TopoDS.Face(shape);
  }

  return shape;
}

function makeExplorer(oc, shape, kind) {
  try {
    return makeInstance(oc, 'TopExp_Explorer', [shape, kind]);
  } catch {
    const explorer = makeInstance(oc, 'TopExp_Explorer');
    explorer.Init(shape, kind, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_SHAPE'));
    return explorer;
  }
}

function edgeFromExplorer(oc, explorer) {
  const shape = callAny(explorer, ['Current']);

  if (oc.TopoDS?.Edge_1) {
    return oc.TopoDS.Edge_1(shape);
  }

  if (oc.TopoDS?.Edge) {
    return oc.TopoDS.Edge(shape);
  }

  return shape;
}

function getCoord(point, name) {
  return callAny(point, [name]);
}

function shapeOrientation(shape) {
  return callAny(shape, ['Orientation', 'Orientation_1']);
}

function shapeKey(shape, fallback) {
  return typeof shape?.HashCode === 'function' ? shape.HashCode(1000000007) : fallback;
}

function transformPoint(point, transform) {
  if (!transform) {
    return point;
  }

  try {
    return callAny(point, ['Transformed'], [transform]);
  } catch {
    callAny(point, ['Transform'], [transform]);
    return point;
  }
}

function normalizeVector(nx, ny, nz) {
  const length = Math.hypot(nx, ny, nz);

  if (length === 0) {
    return { nx: 0, ny: 0, nz: 1 };
  }

  return { nx: nx / length, ny: ny / length, nz: nz / length };
}

function transformNormal(oc, normal, transform) {
  if (!transform) {
    return normal;
  }

  const vector = makeInstance(oc, 'gp_Vec', [normal.nx, normal.ny, normal.nz]);
  const transformed = callAny(vector, ['Transformed'], [transform]);
  return normalizeVector(getCoord(transformed, 'X'), getCoord(transformed, 'Y'), getCoord(transformed, 'Z'));
}

function triangulationForFace(oc, face) {
  const location = makeInstance(oc, 'TopLoc_Location');
  const purposeCandidates = [
    enumValue(oc, 'Poly_MeshPurpose', 'Poly_MeshPurpose_NONE'),
    enumValue(oc, 'Poly_MeshPurpose', 'Poly_MeshPurpose_Shading'),
    enumValue(oc, 'Poly_MeshPurpose', 'Poly_MeshPurpose_AnyFallback'),
    0,
    2,
    0xffff
  ];
  const seenPurposes = new Set();
  const errors = [];

  for (const candidate of purposeCandidates) {
    const meshPurpose = statusValue(candidate);

    if (!Number.isFinite(meshPurpose) || seenPurposes.has(meshPurpose)) {
      continue;
    }

    seenPurposes.add(meshPurpose);

    try {
      const triangulationHandle = oc.BRep_Tool.Triangulation(face, location, meshPurpose);

      if (triangulationHandle && !callAny(triangulationHandle, ['IsNull'])) {
        const triangulation = dereferenceHandle(triangulationHandle);
        const transform = callAny(location, ['Transformation']);
        return { triangulation, transform };
      }
    } catch (error) {
      errors.push(error.message || String(error));
    }
  }

  if (errors.length > 0) {
    throw new Error(`OpenCascade could not access face triangulation: ${errors.join(' | ')}`);
  }

  return null;
}

function triangleVertexIndex(triangle, localIndex) {
  if (typeof triangle.Value === 'function') {
    return triangle.Value(localIndex);
  }

  if (typeof triangle.Get === 'function') {
    return triangle.Get(localIndex);
  }

  return triangle[localIndex - 1];
}

function normalFromFaceSurface(oc, surface, triangulation, nodeIndex, forward, transform) {
  if (!callAny(triangulation, ['HasUVNodes'])) {
    throw new Error('OpenCascade triangulation has no UV nodes for analytic surface normal evaluation.');
  }

  const uv = callAny(triangulation, ['UVNode'], [nodeIndex]);
  const normal = normalFromDerivatives(oc, surface, callAny(uv, ['X']), callAny(uv, ['Y']), forward);
  return transformNormal(oc, normal, transform);
}

function appendFaceTriangulation(oc, face, output) {
  const data = triangulationForFace(oc, face);

  if (!data) {
    return null;
  }

  const { triangulation, transform } = data;
  const vertexOffset = output.positions.length / 3;
  const triangleOffset = output.indices.length / 3;
  const nodeCount = callAny(triangulation, ['NbNodes']);
  const triangleCount = callAny(triangulation, ['NbTriangles']);
  const reversed = shapeOrientation(face) === enumValue(oc, 'TopAbs_Orientation', 'TopAbs_REVERSED');
  const forward = !reversed;
  const surface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);

  for (let nodeIndex = 1; nodeIndex <= nodeCount; nodeIndex += 1) {
    const point = transformPoint(callAny(triangulation, ['Node'], [nodeIndex]), transform);
    const normal = normalFromFaceSurface(oc, surface, triangulation, nodeIndex, forward, transform);

    output.positions.push(getCoord(point, 'X'), getCoord(point, 'Y'), getCoord(point, 'Z'));
    output.normals.push(normal.nx, normal.ny, normal.nz);
  }

  for (let triangleIndex = 1; triangleIndex <= triangleCount; triangleIndex += 1) {
    const triangle = callAny(triangulation, ['Triangle'], [triangleIndex]);
    const a = vertexOffset + triangleVertexIndex(triangle, 1) - 1;
    const b = vertexOffset + triangleVertexIndex(triangle, 2) - 1;
    const c = vertexOffset + triangleVertexIndex(triangle, 3) - 1;

    if (reversed) {
      output.indices.push(a, c, b);
    } else {
      output.indices.push(a, b, c);
    }
  }

  return {
    first: triangleOffset,
    last: triangleOffset + triangleCount - 1
  };
}

function getSurfaceType(oc, surface) {
  const type = callAny(surface, ['GetType']);

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Plane')) {
    return 'plane';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Cylinder')) {
    return 'cylinder';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Cone')) {
    return 'cone';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Sphere')) {
    return 'sphere';
  }

  if (type === enumValue(oc, 'GeomAbs_SurfaceType', 'GeomAbs_Torus')) {
    return 'torus';
  }

  return 'generic';
}

function directionToArray(direction) {
  return [getCoord(direction, 'X'), getCoord(direction, 'Y'), getCoord(direction, 'Z')];
}

function vectorDot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function axisToData(axis) {
  return {
    location: pointToArray(callAny(axis, ['Location'])),
    direction: directionToArray(callAny(axis, ['Direction']))
  };
}

function faceBoundaryTouchesPoint(oc, face, target, tolerance) {
  const explorer = makeExplorer(oc, face, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_EDGE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const edge = edgeFromExplorer(oc, explorer);
    let curve;

    try {
      curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
    } catch {
      continue;
    }

    const first = callAny(curve, ['FirstParameter']);
    const last = callAny(curve, ['LastParameter']);

    if (!Number.isFinite(first) || !Number.isFinite(last)) {
      continue;
    }

    for (const parameter of [first, (first + last) * 0.5, last]) {
      if (distanceBetween(pointToArray(callAny(curve, ['Value'], [parameter])), target) <= tolerance) {
        return true;
      }
    }
  }

  return false;
}

function primitiveSplitSurfacesForFace(oc, face, draftAngleDegrees) {
  const surface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);
  const surfaceType = getSurfaceType(oc, surface);
  const normalDirection = shapeOrientation(face) === enumValue(oc, 'TopAbs_Orientation', 'TopAbs_REVERSED') ? -1 : 1;

  if (surfaceType === 'cylinder') {
    const cylinder = callAny(surface, ['Cylinder']);
    const axis = axisToData(callAny(cylinder, ['Axis']));
    return findCylinderSplitSurfaces({
      axis: axis.direction,
      location: pointToArray(callAny(cylinder, ['Location'])),
      radius: callAny(cylinder, ['Radius']),
      normalDirection
    }, draftAngleDegrees);
  }

  if (surfaceType === 'cone') {
    const cone = callAny(surface, ['Cone']);
    const axis = axisToData(callAny(cone, ['Axis']));
    const apex = pointToArray(callAny(cone, ['Apex']));

    return findConeSplitSurfaces({
      apex,
      axis: axis.direction,
      semiAngle: callAny(cone, ['SemiAngle']),
      normalDirection
    }, draftAngleDegrees);
  }

  if (surfaceType === 'sphere') {
    const sphere = callAny(surface, ['Sphere']);
    return findSphereSplitSurfaces({
      center: pointToArray(callAny(sphere, ['Location'])),
      radius: callAny(sphere, ['Radius']),
      normalDirection
    }, draftAngleDegrees);
  }

  if (surfaceType === 'torus') {
    const torus = callAny(surface, ['Torus']);
    const axis = axisToData(callAny(torus, ['Axis']));
    const position = callAny(torus, ['Position']);
    const majorRadius = callAny(torus, ['MajorRadius']);
    const minorRadius = callAny(torus, ['MinorRadius']);
    return findTorusSplitSurfaces({
      axis: axis.direction,
      center: pointToArray(callAny(torus, ['Location'])),
      xDirection: directionToArray(callAny(position, ['XDirection'])),
      majorRadius,
      minorRadius,
      normalDirection
    }, draftAngleDegrees);
  }

  return [];
}

function makePlaneFromCoefficients(oc, plane) {
  return makeInstance(oc, 'gp_Pln', [
    makeInstance(oc, 'gp_Pnt', plane.point),
    makeInstance(oc, 'gp_Dir', plane.normal)
  ]);
}

function upcastToGeomSurfaceHandle(oc, surfaceHandle) {
  try {
    return makeInstance(oc, 'Handle_Geom_Surface', [dereferenceHandle(surfaceHandle)]);
  } catch {
    return surfaceHandle;
  }
}

function makeBSplineSurfaceFromPointGrid(oc, pointGrid) {
  const rowCount = pointGrid.length;
  const colCount = pointGrid[0]?.length || 0;

  if (rowCount < 2 || colCount < 2) {
    return null;
  }

  const points = makeInstance(oc, 'TColgp_Array2OfPnt', [1, rowCount, 1, colCount]);

  for (let row = 0; row < rowCount; row += 1) {
    for (let col = 0; col < colCount; col += 1) {
      const point = pointGrid[row][col];
      callAny(points, ['SetValue'], [row + 1, col + 1, makeInstance(oc, 'gp_Pnt', point)]);
    }
  }

  const builder = makeInstance(oc, 'GeomAPI_PointsToBSplineSurface', [
    points,
    3,
    8,
    enumValue(oc, 'GeomAbs_Shape', 'GeomAbs_C2'),
    1e-4
  ]);

  if (!callAny(builder, ['IsDone'])) {
    return null;
  }

  return upcastToGeomSurfaceHandle(oc, callAny(builder, ['Surface']));
}

function makeFaceFromBuilder(oc, builder) {
  if (!callAny(builder, ['IsDone'])) {
    return null;
  }

  const face = callAny(builder, ['Face']);
  return callAny(face, ['IsNull']) ? null : face;
}

function tryMakeFaceBuilder(oc, args, initArgs = null) {
  try {
    return makeInstance(oc, 'BRepBuilderAPI_MakeFace', args);
  } catch {
    // Try the explicit Init overloads below.
  }

  if (!initArgs) {
    return null;
  }

  try {
    const builder = makeInstance(oc, 'BRepBuilderAPI_MakeFace');
    callAny(builder, ['Init'], initArgs);
    return builder;
  } catch {
    return null;
  }
}

function makeFaceFromSurfaceHandle(oc, surfaceHandle, tolerance = 1e-7) {
  const attempts = [
    () => tryMakeFaceBuilder(oc, [surfaceHandle, tolerance], [surfaceHandle, true, tolerance]),
    () => tryMakeFaceBuilder(oc, [surfaceHandle, 0, 1, 0, 1, tolerance], [surfaceHandle, 0, 1, 0, 1, tolerance])
  ];

  for (const attempt of attempts) {
    const builder = attempt();
    const face = builder ? makeFaceFromBuilder(oc, builder) : null;

    if (face) {
      return face;
    }
  }

  return null;
}

function makeToolFaceFromSplitSurface(oc, splitSurface) {
  if (splitSurface.type === 'plane') {
    const builder = tryMakeFaceBuilder(oc, [makePlaneFromCoefficients(oc, splitSurface)]);
    return builder ? makeFaceFromBuilder(oc, builder) : null;
  }

  if (splitSurface.type === 'pointGridSurface') {
    const surfaceHandle = makeBSplineSurfaceFromPointGrid(oc, splitSurface.points);

    if (!surfaceHandle) {
      return null;
    }

    return makeFaceFromSurfaceHandle(oc, surfaceHandle);
  }

  return null;
}

function normalFromDerivatives(oc, surface, u, v, forward) {
  const point = makeInstance(oc, 'gp_Pnt');
  const du = makeInstance(oc, 'gp_Vec');
  const dv = makeInstance(oc, 'gp_Vec');

  callAny(surface, ['D1'], [u, v, point, du, dv]);

  let nx = callAny(du, ['Y']) * callAny(dv, ['Z']) - callAny(du, ['Z']) * callAny(dv, ['Y']);
  let ny = callAny(du, ['Z']) * callAny(dv, ['X']) - callAny(du, ['X']) * callAny(dv, ['Z']);
  let nz = callAny(du, ['X']) * callAny(dv, ['Y']) - callAny(du, ['Y']) * callAny(dv, ['X']);
  const length = Math.hypot(nx, ny, nz);

  ({ nx, ny, nz } = normalizeVector(nx, ny, nz));

  if (!forward) {
    nx = -nx;
    ny = -ny;
    nz = -nz;
  }

  return { nx, ny, nz };
}

function safeBuildEdgeCurves(oc, edge, face) {
  tryCallAnyArgs(oc.BRepLib, ['BuildCurve3d'], [[edge, 1e-7, enumValue(oc, 'GeomAbs_Shape', 'GeomAbs_C1'), 14, 16]]);
  tryCallAnyArgs(oc.BRepLib, ['SameParameter_1', 'SameParameter'], [[edge, 1e-7]]);
  tryCallAnyArgs(oc.BRepLib, ['SameParameter_3', 'SameParameter'], [[face, 1e-7, true]]);
}

function sectionFaceWithPlane(oc, face, plane) {
  let section;

  try {
    section = makeInstance(oc, 'BRepAlgoAPI_Section', [face, plane, false]);
  } catch {
    return [];
  }

  tryCallAnyArgs(section, ['Approximation'], [[true]]);
  tryCallAnyArgs(section, ['ComputePCurveOn1'], [[true]]);
  tryCallAnyArgs(section, ['Build'], [[makeInstance(oc, 'Message_ProgressRange')], []]);

  const done = tryCallAnyArgs(section, ['IsDone'], [[]]);
  const hasErrors = tryCallAnyArgs(section, ['HasErrors'], [[]]);

  if ((done.called && !done.value) || (hasErrors.called && hasErrors.value)) {
    return [];
  }

  let sectionShape;

  try {
    sectionShape = callAny(section, ['Shape']);
  } catch {
    return [];
  }

  if (callAny(sectionShape, ['IsNull'])) {
    return [];
  }

  const edges = [];
  const explorer = makeExplorer(oc, sectionShape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_EDGE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const edge = edgeFromExplorer(oc, explorer);
    safeBuildEdgeCurves(oc, edge, face);
    edges.push(edge);
  }

  return edges;
}

function sectionFaceWithGeomSurface(oc, face, surfaceHandle) {
  let section;

  try {
    section = makeInstance(oc, 'BRepAlgoAPI_Section', [face, surfaceHandle, false]);
  } catch {
    return [];
  }

  tryCallAnyArgs(section, ['Approximation'], [[true]]);
  tryCallAnyArgs(section, ['ComputePCurveOn1'], [[true]]);
  tryCallAnyArgs(section, ['Build'], [[makeInstance(oc, 'Message_ProgressRange')], []]);

  const done = tryCallAnyArgs(section, ['IsDone'], [[]]);
  const hasErrors = tryCallAnyArgs(section, ['HasErrors'], [[]]);

  if ((done.called && !done.value) || (hasErrors.called && hasErrors.value)) {
    return [];
  }

  let sectionShape;

  try {
    sectionShape = callAny(section, ['Shape']);
  } catch {
    return [];
  }

  if (callAny(sectionShape, ['IsNull'])) {
    return [];
  }

  const edges = [];
  const explorer = makeExplorer(oc, sectionShape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_EDGE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const edge = edgeFromExplorer(oc, explorer);
    safeBuildEdgeCurves(oc, edge, face);
    edges.push(edge);
  }

  return edges;
}

function sectionFaceWithSplitSurface(oc, face, splitSurface) {
  if (splitSurface.type === 'plane') {
    return sectionFaceWithPlane(oc, face, makePlaneFromCoefficients(oc, splitSurface));
  }

  if (splitSurface.type === 'pointGridSurface') {
    const surfaceHandle = makeBSplineSurfaceFromPointGrid(oc, splitSurface.points);
    return surfaceHandle ? sectionFaceWithGeomSurface(oc, face, surfaceHandle) : [];
  }

  return [];
}

function countFaces(oc, shape) {
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));
  let count = 0;

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    count += 1;
  }

  return count;
}

function collectShapeEdges(oc, shape) {
  const edges = [];
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_EDGE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    edges.push(edgeFromExplorer(oc, explorer));
  }

  return edges;
}

function trySplitFaceWithEdges(oc, shape, face, edges, checkInterior = true) {
  const splitShape = makeInstance(oc, 'BRepFeat_SplitShape', [shape]);
  let addedSplits = 0;

  callAny(splitShape, ['SetCheckInterior'], [checkInterior]);

  for (const edge of edges) {
    try {
      callAny(splitShape, ['Add_3'], [edge, face]);
      addedSplits += 1;
    } catch {
      // Try any other split edges for this same analytic boundary.
    }
  }

  if (addedSplits === 0) {
    return null;
  }

  tryCallAnyArgs(splitShape, ['Build', 'Perform', 'PerformResult'], [[makeInstance(oc, 'Message_ProgressRange')], []]);

  const done = tryCallAnyArgs(splitShape, ['IsDone'], [[]]);

  if (done.called && !done.value) {
    return null;
  }

  try {
    const result = callAny(splitShape, ['Shape']);
    return callAny(result, ['IsNull']) ? null : result;
  } catch {
    return null;
  }
}

function makeWireFromEdges(oc, edges) {
  if (edges.length === 0) {
    return null;
  }

  const builder = makeInstance(oc, 'BRepBuilderAPI_MakeWire');

  for (const edge of edges) {
    try {
      callAny(builder, ['Add_1', 'Add'], [edge]);
    } catch {
      return null;
    }
  }

  const done = tryCallAnyArgs(builder, ['IsDone'], [[]]);

  if (done.called && !done.value) {
    return null;
  }

  try {
    const wire = callAny(builder, ['Wire']);
    return callAny(wire, ['IsNull']) ? null : wire;
  } catch {
    return null;
  }
}

function splitEdgeGroupsForWires(oc, edges) {
  const wires = [];

  if (edges.length > 1) {
    const allEdgesWire = makeWireFromEdges(oc, edges);

    if (allEdgesWire) {
      wires.push({ edges, wire: allEdgesWire });
    }
  }

  for (const edge of edges) {
    const wire = makeWireFromEdges(oc, [edge]);

    if (wire) {
      wires.push({ edges: [edge], wire });
    }
  }

  return wires;
}

function trySplitFaceWithWires(oc, shape, face, wires, checkInterior = true) {
  const splitShape = makeInstance(oc, 'BRepFeat_SplitShape', [shape]);
  let addedSplits = 0;

  callAny(splitShape, ['SetCheckInterior'], [checkInterior]);

  for (const wire of wires) {
    try {
      callAny(splitShape, ['Add_2'], [wire, face]);
      addedSplits += 1;
    } catch {
      // Try any other split wires for this same analytic boundary.
    }
  }

  if (addedSplits === 0) {
    return null;
  }

  tryCallAnyArgs(splitShape, ['Build', 'Perform', 'PerformResult'], [[makeInstance(oc, 'Message_ProgressRange')], []]);

  const done = tryCallAnyArgs(splitShape, ['IsDone'], [[]]);

  if (done.called && !done.value) {
    return null;
  }

  try {
    const result = callAny(splitShape, ['Shape']);
    return callAny(result, ['IsNull']) ? null : result;
  } catch {
    return null;
  }
}

function shapeListOf(oc, shapes) {
  const list = makeInstance(oc, 'TopTools_ListOfShape');

  for (const shape of shapes) {
    callAny(list, ['Append'], [shape]);
  }

  return list;
}

function tryBooleanSplitShape(oc, shape, edges) {
  if (edges.length === 0) {
    return null;
  }

  const splitter = makeInstance(oc, 'BRepAlgoAPI_Splitter');

  try {
    callAny(splitter, ['SetArguments'], [shapeListOf(oc, [shape])]);
    callAny(splitter, ['SetTools'], [shapeListOf(oc, edges)]);
  } catch {
    return null;
  }

  tryCallAnyArgs(splitter, ['Build', 'Perform'], [[makeInstance(oc, 'Message_ProgressRange')], []]);

  const done = tryCallAnyArgs(splitter, ['IsDone'], [[]]);
  const hasErrors = tryCallAnyArgs(splitter, ['HasErrors'], [[]]);

  if ((done.called && !done.value) || (hasErrors.called && hasErrors.value)) {
    return null;
  }

  try {
    const result = callAny(splitter, ['Shape']);
    return callAny(result, ['IsNull']) ? null : result;
  } catch {
    return null;
  }
}

function tryBooleanSplitFaceIntoShape(oc, shape, face, tools) {
  if (tools.length === 0) {
    return null;
  }

  const splitFaceShape = tryBooleanSplitShape(oc, face, tools);

  if (!splitFaceShape || countFaces(oc, splitFaceShape) <= 1) {
    return null;
  }

  try {
    const reshaper = makeInstance(oc, 'BRepTools_ReShape');
    callAny(reshaper, ['Replace'], [face, splitFaceShape]);
    const result = callAny(reshaper, ['Apply'], [shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE')]);
    return callAny(result, ['IsNull']) ? null : result;
  } catch {
    return null;
  }
}

function normalizeAngleNearRange(angle, min, max, period) {
  const values = [];
  const firstTurn = Math.floor((min - angle) / period) - 1;
  const lastTurn = Math.ceil((max - angle) / period) + 1;

  for (let turn = firstTurn; turn <= lastTurn; turn += 1) {
    const value = angle + period * turn;

    if (value >= min && value <= max) {
      values.push(value);
    }
  }

  return values;
}

function coneUSplitValuesFromPlane(oc, faceSurface, splitSurface) {
  if (splitSurface.type !== 'plane' || !splitSurface.normal) {
    return [];
  }

  const cone = callAny(faceSurface, ['Cone']);
  const position = callAny(cone, ['Position']);
  const xDirection = directionToArray(callAny(position, ['XDirection']));
  const yDirection = directionToArray(callAny(position, ['YDirection']));
  const axisDirection = directionToArray(callAny(position, ['Direction']));
  const semiAngle = callAny(cone, ['SemiAngle']);
  const tanSemiAngle = Math.tan(semiAngle);
  const a = vectorDot(splitSurface.normal, xDirection);
  const b = vectorDot(splitSurface.normal, yDirection);
  const c = vectorDot(splitSurface.normal, axisDirection) * tanSemiAngle;
  const radius = Math.hypot(a, b);

  if (radius <= 1e-12) {
    return [];
  }

  const ratio = -c / radius;

  if (ratio < -1 - 1e-10 || ratio > 1 + 1e-10) {
    return [];
  }

  const clampedRatio = Math.max(-1, Math.min(1, ratio));
  const phase = Math.atan2(b, a);
  const delta = Math.acos(clampedRatio);
  const rawRoots = [phase + delta, phase - delta];
  const uMin = callAny(faceSurface, ['FirstUParameter']);
  const uMax = callAny(faceSurface, ['LastUParameter']);
  const period = tryCallAnyArgs(faceSurface, ['UPeriod'], [[]]);
  const uPeriod = period.called && Number.isFinite(period.value) && Math.abs(period.value) > 1e-12
    ? Math.abs(period.value)
    : Math.PI * 2;
  const tolerance = Math.max(1e-8, Math.abs(uMax - uMin) * 1e-8);
  const splitValues = [];

  for (const root of rawRoots) {
    const candidates = normalizeAngleNearRange(root, uMin, uMax, uPeriod);

    for (const value of candidates) {
      if (value <= uMin + tolerance || value >= uMax - tolerance) {
        continue;
      }

      if (!splitValues.some((existing) => Math.abs(existing - value) <= tolerance)) {
        splitValues.push(value);
      }
    }
  }

  return splitValues.sort((left, right) => left - right);
}

function makeRealSequenceHandle(oc, values) {
  const sequence = makeInstance(oc, 'TColStd_HSequenceOfReal');

  for (const value of values) {
    callAny(sequence, ['Append'], [value]);
  }

  return makeInstance(oc, 'Handle_TColStd_HSequenceOfReal', [sequence]);
}

function realSequenceValues(sequenceHandle) {
  try {
    const sequence = dereferenceHandle(sequenceHandle);
    const length = callAny(sequence, ['Length', 'Size']);
    const values = [];

    for (let index = 1; index <= length; index += 1) {
      values.push(callAny(sequence, ['Value'], [index]));
    }

    return values;
  } catch (error) {
    return { error: error.message || String(error) };
  }
}

function shapeExtendStatusFlags(oc, target) {
  const names = [
    'ShapeExtend_OK',
    'ShapeExtend_DONE1',
    'ShapeExtend_DONE2',
    'ShapeExtend_DONE3',
    'ShapeExtend_DONE4',
    'ShapeExtend_DONE5',
    'ShapeExtend_DONE6',
    'ShapeExtend_DONE7',
    'ShapeExtend_DONE8',
    'ShapeExtend_DONE',
    'ShapeExtend_FAIL1',
    'ShapeExtend_FAIL2',
    'ShapeExtend_FAIL3',
    'ShapeExtend_FAIL4',
    'ShapeExtend_FAIL5',
    'ShapeExtend_FAIL6',
    'ShapeExtend_FAIL7',
    'ShapeExtend_FAIL8',
    'ShapeExtend_FAIL'
  ];
  const flags = {};

  for (const name of names) {
    const value = enumValue(oc, 'ShapeExtend_Status', name);

    if (value === undefined) {
      continue;
    }

    const status = tryCallAnyArgs(target, ['Status'], [[value]]);

    if (status.called && status.value) {
      flags[name] = true;
    }
  }

  return flags;
}

function replaceFaceInShape(oc, shape, face, replacement) {
  try {
    const reshaper = makeInstance(oc, 'BRepTools_ReShape');
    callAny(reshaper, ['Replace'], [face, replacement]);
    const result = callAny(reshaper, ['Apply'], [shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE')]);
    return callAny(result, ['IsNull']) ? null : result;
  } catch {
    return null;
  }
}

function makeCompoundFromShapes(oc, shapes) {
  const builder = makeInstance(oc, 'BRep_Builder');
  const compound = makeInstance(oc, 'TopoDS_Compound');

  callAny(builder, ['MakeCompound'], [compound]);

  for (const shape of shapes) {
    callAny(builder, ['Add'], [compound, shape]);
  }

  return compound;
}

function tryParametricApexConeUSplit(oc, shape, face, faceSurface, uSplitValues, bounds) {
  const tolerance = Math.max(1e-8, Math.abs(bounds.uLast - bounds.uFirst) * 1e-8);
  const intervals = [
    [bounds.uFirst, uSplitValues[0]],
    [uSplitValues[0], bounds.uLast]
  ].filter(([uMin, uMax]) => uMax - uMin > tolerance);
  const faces = [];
  const faceOrientation = shapeOrientation(face);

  if (intervals.length < 2) {
    return {
      error: 'Parametric apex cone split did not have two interior U intervals.',
      resultFaces: null,
      shape: null
    };
  }

  try {
    const cone = callAny(faceSurface, ['Cone']);

    for (const [uMin, uMax] of intervals) {
      const builder = makeInstance(oc, 'BRepBuilderAPI_MakeFace', [
        cone,
        uMin,
        uMax,
        bounds.vFirst,
        bounds.vLast
      ]);

      if (!callAny(builder, ['IsDone'])) {
        return {
          error: `BRepBuilderAPI_MakeFace failed for U interval [${uMin}, ${uMax}].`,
          resultFaces: null,
          shape: null
        };
      }

      const splitFace = callAny(builder, ['Face']);

      if (callAny(splitFace, ['IsNull'])) {
        return {
          error: `BRepBuilderAPI_MakeFace produced a null face for U interval [${uMin}, ${uMax}].`,
          resultFaces: null,
          shape: null
        };
      }

      callAny(splitFace, ['Orientation'], [faceOrientation]);
      faces.push(splitFace);
    }

    const compound = makeCompoundFromShapes(oc, faces);
    const resultShape = replaceFaceInShape(oc, shape, face, compound);

    return {
      error: resultShape ? null : 'Parametric apex cone split could not replace the original face.',
      resultFaces: resultShape ? countFaces(oc, resultShape) : null,
      shape: resultShape
    };
  } catch (error) {
    return {
      error: error.message || String(error),
      resultFaces: null,
      shape: null
    };
  }
}

function tryFaceDivideApexCone(oc, shape, face, faceSurface, splitSurfaces) {
  const uSplitValues = splitSurfaces.flatMap((splitSurface) => coneUSplitValuesFromPlane(oc, faceSurface, splitSurface));
  const uniqueUSplitValues = [];
  const tolerance = 1e-8;
  const uFirst = callAny(faceSurface, ['FirstUParameter']);
  const uLast = callAny(faceSurface, ['LastUParameter']);
  const vFirst = callAny(faceSurface, ['FirstVParameter']);
  const vLast = callAny(faceSurface, ['LastVParameter']);
  const bounds = { uFirst, uLast, vFirst, vLast };

  for (const value of uSplitValues) {
    if (!uniqueUSplitValues.some((existing) => Math.abs(existing - value) <= tolerance)) {
      uniqueUSplitValues.push(value);
    }
  }

  uniqueUSplitValues.sort((left, right) => left - right);

  if (uniqueUSplitValues.length === 0) {
    return {
      error: 'No interior U split values were found for the apex cone.',
      bounds,
      resultFaces: null,
      shape: null,
      uSplitValues: uniqueUSplitValues
    };
  }

  if (!oc.TColStd_HSequenceOfReal && !oc.TColStd_HSequenceOfReal_1) {
    const parametricSplit = tryParametricApexConeUSplit(oc, shape, face, faceSurface, uniqueUSplitValues, bounds);

    return {
      attempts: [
        {
          error: 'OpenCascade.js does not expose TColStd_HSequenceOfReal, so FaceDivide cannot receive explicit U split values in this build.',
          method: 'face-divide-direct',
          resultFaces: null
        },
        {
          error: parametricSplit.error,
          method: 'apex-cone-parametric-u-split',
          resultFaces: parametricSplit.resultFaces
        }
      ],
      error: parametricSplit.error,
      bounds,
      resultFaces: parametricSplit.resultFaces,
      shape: parametricSplit.shape,
      uSplitValues: uniqueUSplitValues
    };
  }

  try {
    const location = makeInstance(oc, 'TopLoc_Location');
    const surfaceHandle = callAny(oc.BRep_Tool, ['Surface'], [face, location]);
    const splitSurfaceTool = makeInstance(oc, 'ShapeUpgrade_SplitSurface');
    const attempts = [];
    const debug = {
      bounds,
      requestedUSplitValues: uniqueUSplitValues,
      splitSurfaces: splitSurfaces.map((splitSurface) => ({
        normal: splitSurface.normal,
        point: splitSurface.point,
        type: splitSurface.type
      })),
      surfaceHandleIsNull: typeof surfaceHandle?.IsNull === 'function' ? surfaceHandle.IsNull() : null
    };

    callAny(splitSurfaceTool, ['Init'], [surfaceHandle, uFirst, uLast, vFirst, vLast]);
    callAny(splitSurfaceTool, ['SetUSplitValues'], [makeRealSequenceHandle(oc, uniqueUSplitValues)]);
    debug.splitSurfaceToolUSplitValuesAfterSet = realSequenceValues(callAny(splitSurfaceTool, ['USplitValues']));
    debug.splitSurfaceToolPerform = tryCallAnyArgs(splitSurfaceTool, ['Perform', 'Build', 'Compute'], [[true], [false], []]);
    debug.splitSurfaceToolUSplitValuesAfterPerform = realSequenceValues(callAny(splitSurfaceTool, ['USplitValues']));
    debug.splitSurfaceToolStatus = shapeExtendStatusFlags(oc, splitSurfaceTool);

    const faceDivide = makeInstance(oc, 'ShapeUpgrade_FaceDivide', [face]);
    callAny(faceDivide, ['SetSurfaceSegmentMode'], [true]);
    callAny(faceDivide, ['SetSplitSurfaceTool'], [makeInstance(oc, 'Handle_ShapeUpgrade_SplitSurface', [splitSurfaceTool])]);
    debug.faceDivideSplitSurfaceHandleIsNull = (() => {
      try {
        return callAny(faceDivide, ['GetSplitSurfaceTool']).IsNull();
      } catch {
        return null;
      }
    })();

    const performed = callAny(faceDivide, ['Perform']);
    debug.faceDividePerform = performed;
    debug.faceDivideStatusAfterPerform = shapeExtendStatusFlags(oc, faceDivide);

    if (!performed) {
      attempts.push({
        debug,
        error: 'ShapeUpgrade_FaceDivide.Perform returned false.',
        method: 'face-divide-direct',
        resultFaces: null
      });
    } else {
      const dividedFace = callAny(faceDivide, ['Result']);

      if (!dividedFace || callAny(dividedFace, ['IsNull'])) {
        attempts.push({
          debug,
          error: 'ShapeUpgrade_FaceDivide returned a null result.',
          method: 'face-divide-direct',
          resultFaces: null
        });
      } else {
        const dividedFaceCount = countFaces(oc, dividedFace);

        attempts.push({
          debug,
          error: dividedFaceCount > 1 ? null : 'ShapeUpgrade_FaceDivide did not produce multiple faces.',
          method: 'face-divide-direct',
          resultFaces: dividedFaceCount
        });

        if (dividedFaceCount > 1) {
          const resultShape = replaceFaceInShape(oc, shape, face, dividedFace);

          return {
            attempts,
            error: resultShape ? null : 'FaceDivide result could not replace the original face.',
            bounds,
            resultFaces: resultShape ? countFaces(oc, resultShape) : null,
            shape: resultShape,
            uSplitValues: uniqueUSplitValues
          };
        }
      }
    }

    const shapeDivide = makeInstance(oc, 'ShapeUpgrade_ShapeDivide', [face]);
    callAny(shapeDivide, ['SetSurfaceSegmentMode'], [true]);
    callAny(shapeDivide, ['SetSplitFaceTool'], [makeInstance(oc, 'Handle_ShapeUpgrade_FaceDivide', [faceDivide])]);
    const shapeDividePerformed = callAny(shapeDivide, ['Perform'], [true]);
    debug.shapeDividePerform = shapeDividePerformed;
    debug.shapeDivideStatusAfterPerform = shapeExtendStatusFlags(oc, shapeDivide);

    if (!shapeDividePerformed) {
      return {
        attempts: [
          ...attempts,
          {
            debug,
            error: 'ShapeUpgrade_ShapeDivide.Perform returned false.',
            method: 'shape-divide-face',
            resultFaces: null
          }
        ],
        error: 'ShapeUpgrade_ShapeDivide.Perform returned false.',
        bounds,
        resultFaces: null,
        shape: null,
        uSplitValues: uniqueUSplitValues
      };
    }

    const shapeDivideResult = callAny(shapeDivide, ['Result']);

    if (!shapeDivideResult || callAny(shapeDivideResult, ['IsNull'])) {
      return {
        attempts: [
          ...attempts,
          {
            debug,
            error: 'ShapeUpgrade_ShapeDivide returned a null result.',
            method: 'shape-divide-face',
            resultFaces: null
          }
        ],
        error: 'ShapeUpgrade_ShapeDivide returned a null result.',
        bounds,
        resultFaces: null,
        shape: null,
        uSplitValues: uniqueUSplitValues
      };
    }

    const shapeDivideFaceCount = countFaces(oc, shapeDivideResult);

    if (shapeDivideFaceCount <= 1) {
      return {
        attempts: [
          ...attempts,
          {
            debug,
            error: 'ShapeUpgrade_ShapeDivide did not produce multiple faces.',
            method: 'shape-divide-face',
            resultFaces: shapeDivideFaceCount
          }
        ],
        error: 'ShapeUpgrade_ShapeDivide did not produce multiple faces.',
        bounds,
        resultFaces: shapeDivideFaceCount,
        shape: null,
        uSplitValues: uniqueUSplitValues
      };
    }

    const resultShape = replaceFaceInShape(oc, shape, face, shapeDivideResult);

    return {
      attempts: [
        ...attempts,
        {
          debug,
          error: null,
          method: 'shape-divide-face',
          resultFaces: shapeDivideFaceCount
        }
      ],
      error: resultShape ? null : 'ShapeDivide result could not replace the original face.',
      bounds,
      resultFaces: resultShape ? countFaces(oc, resultShape) : null,
      shape: resultShape,
      uSplitValues: uniqueUSplitValues
    };
  } catch (error) {
    return {
      attempts: [],
      error: error.message || String(error),
      bounds,
      resultFaces: null,
      shape: null,
      uSplitValues: uniqueUSplitValues
    };
  }
}

function splitPrimitiveFacesBySurfaces(oc, shape, draftAngleDegrees) {
  let currentShape = shape;
  const failedSplitFaceKeys = new Set();
  const skippedFaces = new Set();
  const diagnostics = {
    apexConeFaceDivide: [],
    coneBoundaryChecks: [],
    failedCandidates: [],
    generatedSurfaces: [],
    successfulCandidates: [],
    torusSplits: [],
    totals: {},
    totalSplitAttempts: 0,
    successfulSplits: 0
  };
  const maxSplits = 120;

  function surfaceStats(surfaceType) {
    if (!diagnostics.totals[surfaceType]) {
      diagnostics.totals[surfaceType] = {
        faces: 0,
        splitSurfaces: 0,
        sectionEdges: 0,
        toolFaces: 0,
        successfulSplits: 0,
        failedCandidates: 0
      };
    }

    return diagnostics.totals[surfaceType];
  }

  function acceptedSplit(result, beforeFaceCount) {
    return result && countFaces(oc, result) > beforeFaceCount;
  }

  for (let splitIndex = 0; splitIndex < maxSplits; splitIndex += 1) {
    const explorer = makeExplorer(oc, currentShape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));
    const beforeFaceCount = countFaces(oc, currentShape);
    let faceIndex = 0;
    let appliedSplit = false;
    const candidates = [];

    for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
      const face = faceFromExplorer(oc, explorer);
      const faceKey = shapeKey(face, faceIndex);
      const skipKey = `${beforeFaceCount}:${faceKey}`;

      faceIndex += 1;

      if (skippedFaces.has(skipKey)) {
        continue;
      }

      const faceSurface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);
      const surfaceType = getSurfaceType(oc, faceSurface);
      const splitSurfaces = primitiveSplitSurfacesForFace(oc, face, draftAngleDegrees);
      const stats = surfaceStats(surfaceType);
      const edges = [];
      const tools = [];
      const originalBoundaryEdges = surfaceType === 'cone' ? collectShapeEdges(oc, face) : [];
      let coneBoundaryTouchesApex = false;

      if (splitSurfaces.length > 0) {
        if (surfaceType === 'cone') {
          try {
            const cone = callAny(faceSurface, ['Cone']);
            const apex = pointToArray(callAny(cone, ['Apex']));
            const refRadius = callAny(cone, ['RefRadius']);
            const apexTolerance = Math.max(1e-6, Math.abs(refRadius) * 1e-5, distanceBetween(apex, pointToArray(callAny(cone, ['Location']))) * 1e-7);
            coneBoundaryTouchesApex = faceBoundaryTouchesPoint(oc, face, apex, apexTolerance);
          } catch {
            coneBoundaryTouchesApex = false;
          }
        }

        stats.faces += 1;
        stats.splitSurfaces += splitSurfaces.length;
        diagnostics.generatedSurfaces.push({
          coneBoundaryTouchesApex,
          faceIndex: faceIndex - 1,
          surfaceType,
          splitSurfaces: splitSurfaces.map((splitSurface) => {
            if (splitSurface.type === 'plane') {
              return {
                point: splitSurface.point,
                bnormal: splitSurface.normal,
                type: splitSurface.type
              };
            }

            return {
              columns: splitSurface.points?.[0]?.length || 0,
              rows: splitSurface.points?.length || 0,
              type: splitSurface.type
            };
          })
        });
      }

      for (const splitSurface of splitSurfaces) {
        const sectionEdges = sectionFaceWithSplitSurface(oc, face, splitSurface);

        stats.sectionEdges += sectionEdges.length;

        for (const edge of sectionEdges) {
          edges.push(edge);
        }

        const toolFace = makeToolFaceFromSplitSurface(oc, splitSurface);

        if (toolFace) {
          tools.push(toolFace);
          stats.toolFaces += 1;
        }
      }

      if (surfaceType === 'torus' && splitSurfaces.length > 0) {
        diagnostics.torusSplits.push({
          faceIndex: faceIndex - 1,
          faceKey,
          phase: 'candidate-built',
          sectionEdges: edges.length,
          splitSurfaces: splitSurfaces.map((splitSurface) => ({
            columns: splitSurface.points?.[0]?.length || null,
            rows: splitSurface.points?.length || null,
            type: splitSurface.type
          })),
          toolFaces: tools.length
        });
      }

      if (edges.length === 0 && tools.length === 0 && !(surfaceType === 'cone' && coneBoundaryTouchesApex)) {
        skippedFaces.add(skipKey);
        if (splitSurfaces.length > 0) {
          diagnostics.failedCandidates.push({
            faceIndex: faceIndex - 1,
            reason: 'No section edges or tool faces were produced',
            splitSurfaces: splitSurfaces.length,
            surfaceType
          });
          stats.failedCandidates += 1;
        }
        continue;
      }

      candidates.push({
        coneBoundaryTouchesApex,
        edges,
        face,
        faceIndex: faceIndex - 1,
        faceKey,
        faceSurface,
        originalBoundaryEdges,
        skipKey,
        splitSurfaces,
        surfaceType,
        tools
      });
    }

    for (const candidate of candidates) {
      const {
        coneBoundaryTouchesApex,
        edges,
        face,
        faceIndex,
        faceKey,
        faceSurface,
        originalBoundaryEdges,
        skipKey,
        splitSurfaces,
        surfaceType,
        tools
      } = candidate;
      const stats = surfaceStats(surfaceType);
      let nextShape = null;
      const methodResults = [];
      const wireGroups = splitEdgeGroupsForWires(oc, edges);

      diagnostics.totalSplitAttempts += 1;

      if (surfaceType === 'cone' && coneBoundaryTouchesApex) {
        const faceDivideResult = tryFaceDivideApexCone(oc, currentShape, face, faceSurface, splitSurfaces);
        nextShape = faceDivideResult.shape;
        diagnostics.apexConeFaceDivide.push({
          attempts: faceDivideResult.attempts,
          bounds: faceDivideResult.bounds,
          error: faceDivideResult.error,
          faceIndex,
          faceKey,
          resultFaces: faceDivideResult.resultFaces,
          success: acceptedSplit(nextShape, beforeFaceCount),
          uSplitValues: faceDivideResult.uSplitValues
        });
        methodResults.push({
          attempts: faceDivideResult.attempts,
          error: faceDivideResult.error,
          method: 'cone-apex-face-divide-u-split',
          resultFaces: faceDivideResult.resultFaces,
          success: acceptedSplit(nextShape, beforeFaceCount),
          uSplitValues: faceDivideResult.uSplitValues
        });

        if (!acceptedSplit(nextShape, beforeFaceCount)) {
          nextShape = null;
          skippedFaces.add(skipKey);
          failedSplitFaceKeys.add(faceKey);
          diagnostics.failedCandidates.push({
            coneBoundaryTouchesApex,
            edgeTools: edges.length,
            faceIndex,
            faceKey,
            methodResults,
            reason: 'Apex cone FaceDivide did not increase face count',
            surfaceTools: tools.length,
            surfaceType
          });
          stats.failedCandidates += 1;
          continue;
        }
      }

      if (!nextShape && wireGroups.length > 0) {
        nextShape = trySplitFaceWithWires(oc, currentShape, face, wireGroups.map((group) => group.wire));
        methodResults.push({
          method: 'split-shape-wires',
          resultFaces: nextShape ? countFaces(oc, nextShape) : null,
          success: acceptedSplit(nextShape, beforeFaceCount),
          wireTools: wireGroups.length
        });

        if (!acceptedSplit(nextShape, beforeFaceCount)) {
          nextShape = null;
        }
      }

      if (!nextShape && wireGroups.length > 0) {
        nextShape = trySplitFaceWithWires(oc, currentShape, face, wireGroups.map((group) => group.wire), false);
        methodResults.push({
          method: 'split-shape-wires-relaxed-boundary',
          resultFaces: nextShape ? countFaces(oc, nextShape) : null,
          success: acceptedSplit(nextShape, beforeFaceCount),
          wireTools: wireGroups.length
        });

        if (!acceptedSplit(nextShape, beforeFaceCount)) {
          nextShape = null;
        }
      }

      if (!nextShape) {
        for (const group of wireGroups) {
          nextShape = trySplitFaceWithWires(oc, currentShape, face, [group.wire]);
          methodResults.push({
            method: 'split-shape-single-wire',
            resultFaces: nextShape ? countFaces(oc, nextShape) : null,
            success: acceptedSplit(nextShape, beforeFaceCount),
            wireEdges: group.edges.length
          });

          if (acceptedSplit(nextShape, beforeFaceCount)) {
            break;
          }

          nextShape = null;
        }
      }

      if (!nextShape) {
        for (const group of wireGroups) {
          nextShape = trySplitFaceWithWires(oc, currentShape, face, [group.wire], false);
          methodResults.push({
            method: 'split-shape-single-wire-relaxed-boundary',
            resultFaces: nextShape ? countFaces(oc, nextShape) : null,
            success: acceptedSplit(nextShape, beforeFaceCount),
            wireEdges: group.edges.length
          });

          if (acceptedSplit(nextShape, beforeFaceCount)) {
            break;
          }

          nextShape = null;
        }
      }

      if (!nextShape && edges.length > 1) {
        nextShape = trySplitFaceWithEdges(oc, currentShape, face, edges);
        methodResults.push({
          method: 'split-shape-all-edges',
          resultFaces: nextShape ? countFaces(oc, nextShape) : null,
          success: acceptedSplit(nextShape, beforeFaceCount)
        });

        if (!acceptedSplit(nextShape, beforeFaceCount)) {
          nextShape = null;
        }
      }

      if (!nextShape && edges.length > 1) {
        nextShape = trySplitFaceWithEdges(oc, currentShape, face, edges, false);
        methodResults.push({
          method: 'split-shape-all-edges-relaxed-boundary',
          resultFaces: nextShape ? countFaces(oc, nextShape) : null,
          success: acceptedSplit(nextShape, beforeFaceCount)
        });

        if (!acceptedSplit(nextShape, beforeFaceCount)) {
          nextShape = null;
        }
      }

      if (!nextShape) {
        for (const edge of edges) {
          nextShape = trySplitFaceWithEdges(oc, currentShape, face, [edge]);
          methodResults.push({
            method: 'split-shape-single-edge',
            resultFaces: nextShape ? countFaces(oc, nextShape) : null,
            success: acceptedSplit(nextShape, beforeFaceCount)
          });

          if (acceptedSplit(nextShape, beforeFaceCount)) {
            break;
          }

          nextShape = null;
        }
      }

      if (!nextShape) {
        for (const edge of edges) {
          nextShape = trySplitFaceWithEdges(oc, currentShape, face, [edge], false);
          methodResults.push({
            method: 'split-shape-single-edge-relaxed-boundary',
            resultFaces: nextShape ? countFaces(oc, nextShape) : null,
            success: acceptedSplit(nextShape, beforeFaceCount)
          });

          if (acceptedSplit(nextShape, beforeFaceCount)) {
            break;
          }

          nextShape = null;
        }
      }

      if (!nextShape && surfaceType === 'torus' && tools.length > 0) {
        nextShape = tryBooleanSplitFaceIntoShape(oc, currentShape, face, tools);
        methodResults.push({
          method: 'torus-face-boolean-tool-split',
          resultFaces: nextShape ? countFaces(oc, nextShape) : null,
          success: acceptedSplit(nextShape, beforeFaceCount),
          toolFaces: tools.length
        });

        if (!acceptedSplit(nextShape, beforeFaceCount)) {
          nextShape = null;
        }
      }

      if (surfaceType === 'torus') {
        diagnostics.torusSplits.push({
          edgeTools: edges.length,
          faceIndex,
          faceKey,
          methodResults,
          phase: 'candidate-tried',
          resultFaces: nextShape ? countFaces(oc, nextShape) : null,
          success: acceptedSplit(nextShape, beforeFaceCount),
          toolFaces: tools.length
        });
      }

      if (acceptedSplit(nextShape, beforeFaceCount)) {
        const successfulMethod = methodResults.find((result) => result.success)?.method || null;

        if (surfaceType === 'cone') {
          const boundaryCheck = validateConeSplitBoundaries(oc, nextShape, originalBoundaryEdges, edges);
          const ok =
            boundaryCheck.coneFaceBoundary.originalBoundary.ok &&
            boundaryCheck.coneFaceBoundary.splitBoundary.ok &&
            boundaryCheck.coneFaceBoundary.unexplainedBoundary.ok;

          diagnostics.coneBoundaryChecks.push({
            coneBoundaryTouchesApex,
            edgeTools: edges.length,
            faceIndex,
            faceKey,
            method: successfulMethod,
            ok,
            coneFaceBoundary: boundaryCheck.coneFaceBoundary,
            wholeShapeBoundary: boundaryCheck.wholeShapeBoundary,
            toolFaces: tools.length
          });
        }

        diagnostics.successfulCandidates.push({
          coneBoundaryTouchesApex: surfaceType === 'cone' ? coneBoundaryTouchesApex : undefined,
          edgeTools: edges.length,
          faceIndex,
          faceKey,
          method: successfulMethod,
          resultFaces: countFaces(oc, nextShape),
          surfaceType,
          toolFaces: tools.length
        });
        currentShape = nextShape;
        skippedFaces.clear();
        appliedSplit = true;
        diagnostics.successfulSplits += 1;
        stats.successfulSplits += 1;
        break;
      }

      skippedFaces.add(skipKey);
      failedSplitFaceKeys.add(faceKey);
      diagnostics.failedCandidates.push({
        coneBoundaryTouchesApex: surfaceType === 'cone' ? coneBoundaryTouchesApex : undefined,
        edgeTools: edges.length,
        faceIndex,
        faceKey,
        methodResults,
        reason: 'Face-local OCCT edge split did not increase face count',
        surfaceTools: tools.length,
        surfaceType
      });
      stats.failedCandidates += 1;
    }

    if (!appliedSplit) {
      break;
    }
  }

  return { diagnostics, shape: currentShape, failedSplitFaceKeys };
}

function pointToArray(point) {
  return [getCoord(point, 'X'), getCoord(point, 'Y'), getCoord(point, 'Z')];
}

function distanceBetween(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function distanceToSegment(point, start, end) {
  const vx = end[0] - start[0];
  const vy = end[1] - start[1];
  const vz = end[2] - start[2];
  const wx = point[0] - start[0];
  const wy = point[1] - start[1];
  const wz = point[2] - start[2];
  const lengthSquared = vx * vx + vy * vy + vz * vz;

  if (lengthSquared <= 1e-18) {
    return distanceBetween(point, start);
  }

  const t = Math.min(Math.max((wx * vx + wy * vy + wz * vz) / lengthSquared, 0), 1);
  return Math.hypot(
    point[0] - (start[0] + vx * t),
    point[1] - (start[1] + vy * t),
    point[2] - (start[2] + vz * t)
  );
}

function sampleEdgeCurve(oc, edge) {
  const curve = makeInstance(oc, 'BRepAdaptor_Curve', [edge]);
  const first = callAny(curve, ['FirstParameter']);
  const last = callAny(curve, ['LastParameter']);

  if (!Number.isFinite(first) || !Number.isFinite(last)) {
    return [];
  }

  const maxDepth = 14;
  const chordTolerance = 0.015;
  const minParameterSpan = Math.max(Math.abs(last - first) * 1e-8, 1e-9);
  const points = [];

  function valueAt(t) {
    return pointToArray(callAny(curve, ['Value'], [t]));
  }

  function appendAdaptive(t0, p0, t1, p1, depth) {
    const tm = (t0 + t1) * 0.5;
    const pm = valueAt(tm);
    const chordError = distanceToSegment(pm, p0, p1);
    const segmentLength = distanceBetween(p0, p1);

    if (
      depth >= maxDepth ||
      Math.abs(t1 - t0) <= minParameterSpan ||
      (chordError <= chordTolerance && segmentLength <= chordTolerance * 80)
    ) {
      points.push(p1);
      return;
    }

    appendAdaptive(t0, p0, tm, pm, depth + 1);
    appendAdaptive(tm, pm, t1, p1, depth + 1);
  }

  const firstPoint = valueAt(first);
  const lastPoint = valueAt(last);
  points.push(firstPoint);
  appendAdaptive(first, firstPoint, last, lastPoint, 0);

  const positions = [];

  for (const point of points) {
    positions.push(point[0], point[1], point[2]);
  }

  return positions;
}

function sampledPointDistancesToSegments(points, segments) {
  const distances = [];

  for (let index = 0; index + 2 < points.length; index += 3) {
    const point = [points[index], points[index + 1], points[index + 2]];
    let best = Number.POSITIVE_INFINITY;

    for (let segmentIndex = 0; segmentIndex + 5 < segments.length; segmentIndex += 6) {
      best = Math.min(best, distanceToSegment(point, [
        segments[segmentIndex],
        segments[segmentIndex + 1],
        segments[segmentIndex + 2]
      ], [
        segments[segmentIndex + 3],
        segments[segmentIndex + 4],
        segments[segmentIndex + 5]
      ]));
    }

    distances.push(best);
  }

  return distances;
}

function sampledEdgesToPoints(oc, edges) {
  const points = [];

  for (const edge of edges) {
    points.push(...sampleEdgeCurve(oc, edge));
  }

  return points;
}

function sampledEdgesToSegments(oc, edges) {
  const segments = [];

  for (const edge of edges) {
    const points = sampleEdgeCurve(oc, edge);

    for (let index = 0; index + 5 < points.length; index += 3) {
      segments.push(
        points[index],
        points[index + 1],
        points[index + 2],
        points[index + 3],
        points[index + 4],
        points[index + 5]
      );
    }
  }

  return segments;
}

function boundaryCoverageSummaryFromSegments(oc, segments, expectedEdges, tolerance = 0.05) {
  const expectedPoints = sampledEdgesToPoints(oc, expectedEdges);
  return pointCoverageSummaryFromSegments(expectedPoints, segments, tolerance);
}

function pointCoverageSummaryFromSegments(points, segments, tolerance = 0.05) {
  const distances = sampledPointDistancesToSegments(points, segments);
  const missingDistances = distances.filter((distance) => distance > tolerance || !Number.isFinite(distance));

  return {
    checkedPoints: distances.length,
    maxDistance: distances.length > 0 ? Math.max(...distances.filter(Number.isFinite), 0) : null,
    missingPoints: missingDistances.length,
    ok: missingDistances.length === 0,
    tolerance
  };
}

function boundaryCoverageSummary(oc, resultShape, expectedEdges, tolerance = 0.05) {
  return boundaryCoverageSummaryFromSegments(oc, collectBoundaryLines(oc, resultShape), expectedEdges, tolerance);
}

function concatenateSegments(left, right) {
  return [...left, ...right];
}

function collectFaceTypeBoundaryLines(oc, shape, surfaceType) {
  const positions = [];
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const face = faceFromExplorer(oc, explorer);
    const surface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);

    if (getSurfaceType(oc, surface) !== surfaceType) {
      continue;
    }

    positions.push(...collectBoundaryLines(oc, face));
  }

  return positions;
}

function collectRelevantFaceTypeBoundaryLines(oc, shape, surfaceType, expectedSegments, tolerance = 0.05) {
  const positions = [];
  let selectedFaces = 0;
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const face = faceFromExplorer(oc, explorer);
    const surface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);

    if (getSurfaceType(oc, surface) !== surfaceType) {
      continue;
    }

    const faceSegments = collectBoundaryLines(oc, face);
    const facePoints = [];

    for (let index = 0; index + 2 < faceSegments.length; index += 3) {
      facePoints.push(faceSegments[index], faceSegments[index + 1], faceSegments[index + 2]);
    }

    const summary = pointCoverageSummaryFromSegments(facePoints, expectedSegments, tolerance);

    if (summary.checkedPoints > 0 && summary.missingPoints < summary.checkedPoints) {
      positions.push(...faceSegments);
      selectedFaces += 1;
    }
  }

  return { positions, selectedFaces };
}

function validateConeSplitBoundaries(oc, resultShape, originalBoundaryEdges, splitEdges) {
  const coneBoundarySegments = collectFaceTypeBoundaryLines(oc, resultShape, 'cone');
  const expectedBoundarySegments = concatenateSegments(
    sampledEdgesToSegments(oc, originalBoundaryEdges),
    sampledEdgesToSegments(oc, splitEdges)
  );
  const relevantConeBoundary = collectRelevantFaceTypeBoundaryLines(oc, resultShape, 'cone', expectedBoundarySegments);

  return {
    coneFaceBoundary: {
      originalBoundary: boundaryCoverageSummaryFromSegments(oc, coneBoundarySegments, originalBoundaryEdges),
      splitBoundary: boundaryCoverageSummaryFromSegments(oc, coneBoundarySegments, splitEdges),
      unexplainedBoundary: pointCoverageSummaryFromSegments(relevantConeBoundary.positions, expectedBoundarySegments),
      relevantConeFaces: relevantConeBoundary.selectedFaces
    },
    wholeShapeBoundary: {
      originalBoundary: boundaryCoverageSummary(oc, resultShape, originalBoundaryEdges),
      splitBoundary: boundaryCoverageSummary(oc, resultShape, splitEdges)
    }
  };
}

function collectBoundaryLines(oc, shape) {
  const positions = [];
  const edgeKeys = new Set();
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_EDGE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const edge = edgeFromExplorer(oc, explorer);
    const edgeHash = typeof edge.HashCode === 'function' ? edge.HashCode(1000000007) : null;

    if (edgeHash !== null && edgeKeys.has(edgeHash)) {
      continue;
    }

    if (edgeHash !== null) {
      edgeKeys.add(edgeHash);
    }

    const edgePositions = sampleEdgeCurve(oc, edge);

    for (let index = 0; index + 5 < edgePositions.length; index += 3) {
      positions.push(
        edgePositions[index],
        edgePositions[index + 1],
        edgePositions[index + 2],
        edgePositions[index + 3],
        edgePositions[index + 4],
        edgePositions[index + 5]
      );
    }
  }

  return positions;
}

export async function loadStepWithOpenCascade(buffer, draftAngleDegrees) {
  const oc = await getOpenCascade();
  let shape = readStepShape(oc, buffer);

  const splitResult = splitPrimitiveFacesBySurfaces(oc, shape, draftAngleDegrees);
  shape = splitResult.shape;
  const splitStepText = writeStepShape(oc, shape);
  cleanTriangulation(oc, shape);

  const output = {
    positions: [],
    normals: [],
    indices: [],
    brep_faces: [],
    failedFaceIndices: new Set(),
    mixedFaceIndices: new Set(),
    edgePositions: []
  };

  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));
  let faceIndex = 0;

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const face = faceFromExplorer(oc, explorer);

    triangulateFace(oc, face);

    const range = appendFaceTriangulation(oc, face, output);

    if (range) {
      output.brep_faces.push({ ...range, faceIndex });
    }

    faceIndex += 1;
  }

  if (faceIndex === 0) {
    throw new Error('OpenCascade imported the STEP file, but found no BRep faces.');
  }

  if (output.positions.length === 0 || output.indices.length === 0) {
    throw new Error('OpenCascade imported BRep faces, but produced no triangulation for rendering.');
  }

  output.edgePositions = collectBoundaryLines(oc, shape);

  return {
    meshes: [
      {
        name: 'STEP body',
        color: [0.78, 0.8, 0.82],
        attributes: {
          position: {
            array: output.positions
          },
          normal: {
            array: output.normals
          }
        },
        index: {
          array: output.indices
        },
        brep_faces: output.brep_faces,
        edgePositions: output.edgePositions
      }
    ],
    failedFaceIndices: output.failedFaceIndices,
    mixedFaceIndices: output.mixedFaceIndices,
    splitDiagnostics: splitResult.diagnostics,
    splitStepText,
    totalFaces: faceIndex
  };
}
