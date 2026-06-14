import { buildRenderModelFromShape as buildRenderModelFromShapeCore } from './occtRenderModel.js';
import {
  callAny,
  dereferenceHandle,
  enumValue,
  getOpenCascade,
  makeInstance,
  statusValue,
  tryCallAnyArgs
} from './occtRuntime.js';
import {
  readBrepShape,
  readStepShape,
  writeBrepShape,
  writeStepShape
} from './stepIO.js';
import {
  directionToArray,
  distanceBetween,
  edgeFromExplorer,
  faceFromExplorer,
  getCoord,
  makeExplorer,
  pointToArray,
  shapeKey,
  shapeOrientation
} from './shapeTraversal.js';
import {
  faceBoundaryTouchesPoint,
  getSurfaceType,
  isGeneralSurfaceType,
  normalFromDerivatives,
  primitiveSplitSurfacesForFace
} from './surfaceAnalysis.js';
import {
  createSplitDiagnostics,
  mergeSplitDiagnostics,
  surfaceStatsForDiagnostics
} from './splitDiagnostics.js';
import {
  applyReplacementMap,
  collectFaceJobs,
  collectFaces,
  faceAtIndex
} from './faceJobs.js';
import { rotateShape } from './shapeTransform.js';

export { getOpenCascade };

function vectorDot(left, right) {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
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

function upcastToGeomCurveHandle(oc, curveHandle) {
  try {
    return makeInstance(oc, 'Handle_Geom_Curve', [dereferenceHandle(curveHandle)]);
  } catch {
    return curveHandle;
  }
}

function makeBSplineCurveFromPoints(oc, curvePoints) {
  if (!curvePoints || curvePoints.length < 2) {
    return null;
  }

  const points = makeInstance(oc, 'TColgp_Array1OfPnt', [1, curvePoints.length]);

  for (let index = 0; index < curvePoints.length; index += 1) {
    callAny(points, ['SetValue'], [index + 1, makeInstance(oc, 'gp_Pnt', curvePoints[index])]);
  }

  const attempts = [
    () => makeInstance(oc, 'GeomAPI_PointsToBSpline', [points, 3, 8, enumValue(oc, 'GeomAbs_Shape', 'GeomAbs_C2'), 1e-4]),
    () => makeInstance(oc, 'GeomAPI_PointsToBSpline', [points])
  ];

  for (const attempt of attempts) {
    try {
      const builder = attempt();

      if (!callAny(builder, ['IsDone'])) {
        continue;
      }

      return upcastToGeomCurveHandle(oc, callAny(builder, ['Curve']));
    } catch {
      // Try the next overload.
    }
  }

  return null;
}

function makeEdgeFromCurveHandle(oc, curveHandle) {
  if (!curveHandle) {
    return null;
  }

  const attempts = [
    () => makeInstance(oc, 'BRepBuilderAPI_MakeEdge', [curveHandle]),
    () => {
      const curve = dereferenceHandle(curveHandle);
      return makeInstance(oc, 'BRepBuilderAPI_MakeEdge', [curve]);
    }
  ];

  for (const attempt of attempts) {
    try {
      const builder = attempt();

      if (!callAny(builder, ['IsDone'])) {
        continue;
      }

      const edge = callAny(builder, ['Edge']);
      return callAny(edge, ['IsNull']) ? null : edge;
    } catch {
      // Try the next overload.
    }
  }

  return null;
}

function makeContourEdgeFromSplitSurface(oc, splitSurface, face) {
  if (splitSurface.type !== 'pointGridSurface') {
    return null;
  }

  const curveHandle = makeBSplineCurveFromPoints(oc, splitSurface.contourSurfacePoints);
  const edge = makeEdgeFromCurveHandle(oc, curveHandle);

  if (!edge) {
    return null;
  }

  safeBuildEdgeCurves(oc, edge, face);
  return edge;
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
    return [];
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

function acceptedReplacement(oc, replacement) {
  return replacement && countFaces(oc, replacement) > 1;
}

function splitSingleFaceBySurfaces(oc, shape, face, faceIndex, draftAngleDegrees) {
  const diagnostics = createSplitDiagnostics();
  const failedSplitFaceKeys = new Set();
  const faceKey = shapeKey(face, faceIndex);
  const faceSurface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);
  const surfaceType = getSurfaceType(oc, faceSurface);
  const splitSurfaces = primitiveSplitSurfacesForFace(oc, face, draftAngleDegrees);
  const stats = surfaceStatsForDiagnostics(diagnostics, surfaceType);
  const edges = [];
  const tools = [];
  const methodResults = [];
  let coneBoundaryTouchesApex = false;

  if (splitSurfaces.length === 0) {
    return {
      diagnostics,
      failedSplitFaceKeys,
      faceIndex,
      faceKey,
      replacement: null,
      skipped: true,
      surfaceType
    };
  }

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
    faceIndex,
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
        contourLength: splitSurface.contourLength || null,
        contourMaxTurnRadians: splitSurface.contourMaxTurnRadians || null,
        contourPoints: splitSurface.contourPoints || null,
        contourResampledPoints: splitSurface.contourResampledPoints || null,
        contourToolExtendedPoints: splitSurface.contourToolExtendedPoints || null,
        contourSelfIntersects: splitSurface.contourSelfIntersects || false,
        contourValidationCheckedSamples: splitSurface.contourValidationCheckedSamples || null,
        contourValidationScore: splitSurface.contourValidationScore || null,
        contourValidationUnknownSamples: splitSurface.contourValidationUnknownSamples || null,
        contourValidationValidSamples: splitSurface.contourValidationValidSamples || null,
        rawContourCandidates: splitSurface.rawContourCandidates || null,
        rows: splitSurface.points?.length || 0,
        type: splitSurface.type,
        validatedContourCandidates: splitSurface.validatedContourCandidates || null
      };
    })
  });

  for (const splitSurface of splitSurfaces) {
    const contourEdge = makeContourEdgeFromSplitSurface(oc, splitSurface, face);

    if (contourEdge) {
      edges.push(contourEdge);
      stats.sectionEdges += 1;
    }

    const sectionEdges = sectionFaceWithSplitSurface(oc, face, splitSurface);

    stats.sectionEdges += sectionEdges.length;
    edges.push(...sectionEdges);

    const toolFace = makeToolFaceFromSplitSurface(oc, splitSurface);

    if (toolFace) {
      tools.push(toolFace);
      stats.toolFaces += 1;
    }
  }

  if (surfaceType === 'torus') {
    diagnostics.torusSplits.push({
      faceIndex,
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
    failedSplitFaceKeys.add(faceKey);
    diagnostics.failedCandidates.push({
      faceIndex,
      faceKey,
      reason: 'No section edges or tool faces were produced',
      splitSurfaces: splitSurfaces.length,
      surfaceType
    });
    stats.failedCandidates += 1;
    return {
      diagnostics,
      failedSplitFaceKeys,
      faceIndex,
      faceKey,
      replacement: null,
      skipped: false,
      surfaceType
    };
  }

  diagnostics.totalSplitAttempts += 1;
  let replacement = null;
  const wireGroups = splitEdgeGroupsForWires(oc, edges);

  if (surfaceType === 'cone' && coneBoundaryTouchesApex) {
    const faceDivideResult = tryFaceDivideApexCone(oc, face, face, faceSurface, splitSurfaces);
    replacement = faceDivideResult.shape;
    methodResults.push({
      attempts: faceDivideResult.attempts,
      error: faceDivideResult.error,
      method: 'cone-apex-face-divide-u-split',
      resultFaces: faceDivideResult.resultFaces,
      success: acceptedReplacement(oc, replacement),
      uSplitValues: faceDivideResult.uSplitValues
    });
    diagnostics.apexConeFaceDivide.push({
      attempts: faceDivideResult.attempts,
      bounds: faceDivideResult.bounds,
      error: faceDivideResult.error,
      faceIndex,
      faceKey,
      resultFaces: faceDivideResult.resultFaces,
      success: acceptedReplacement(oc, replacement),
      uSplitValues: faceDivideResult.uSplitValues
    });

    if (!acceptedReplacement(oc, replacement)) {
      replacement = null;
    }
  }

  if (!replacement && wireGroups.length > 0) {
    replacement = trySplitFaceWithWires(oc, face, face, wireGroups.map((group) => group.wire));
    methodResults.push({
      method: 'split-face-wires',
      resultFaces: replacement ? countFaces(oc, replacement) : null,
      success: acceptedReplacement(oc, replacement),
      wireTools: wireGroups.length
    });

    if (!acceptedReplacement(oc, replacement)) {
      replacement = null;
    }
  }

  if (!replacement && wireGroups.length > 0) {
    replacement = trySplitFaceWithWires(oc, face, face, wireGroups.map((group) => group.wire), false);
    methodResults.push({
      method: 'split-face-wires-relaxed-boundary',
      resultFaces: replacement ? countFaces(oc, replacement) : null,
      success: acceptedReplacement(oc, replacement),
      wireTools: wireGroups.length
    });

    if (!acceptedReplacement(oc, replacement)) {
      replacement = null;
    }
  }

  if (!replacement && edges.length > 0) {
    replacement = trySplitFaceWithEdges(oc, face, face, edges);
    methodResults.push({
      method: 'split-face-edges',
      resultFaces: replacement ? countFaces(oc, replacement) : null,
      success: acceptedReplacement(oc, replacement)
    });

    if (!acceptedReplacement(oc, replacement)) {
      replacement = null;
    }
  }

  if (!replacement && edges.length > 0) {
    replacement = trySplitFaceWithEdges(oc, face, face, edges, false);
    methodResults.push({
      method: 'split-face-edges-relaxed-boundary',
      resultFaces: replacement ? countFaces(oc, replacement) : null,
      success: acceptedReplacement(oc, replacement)
    });

    if (!acceptedReplacement(oc, replacement)) {
      replacement = null;
    }
  }

  if (!replacement && (surfaceType === 'torus' || isGeneralSurfaceType(surfaceType)) && tools.length > 0) {
    replacement = tryBooleanSplitShape(oc, face, tools);
    methodResults.push({
      method: `${surfaceType}-face-boolean-tool-split`,
      resultFaces: replacement ? countFaces(oc, replacement) : null,
      success: acceptedReplacement(oc, replacement),
      toolFaces: tools.length
    });

    if (!acceptedReplacement(oc, replacement)) {
      replacement = null;
    }
  }

  if (surfaceType === 'torus') {
    diagnostics.torusSplits.push({
      edgeTools: edges.length,
      faceIndex,
      faceKey,
      methodResults,
      phase: 'candidate-tried',
      resultFaces: replacement ? countFaces(oc, replacement) : null,
      success: acceptedReplacement(oc, replacement),
      toolFaces: tools.length
    });
  }

  if (acceptedReplacement(oc, replacement)) {
    const successfulMethod = methodResults.find((result) => result.success)?.method || null;

    diagnostics.successfulCandidates.push({
      coneBoundaryTouchesApex: surfaceType === 'cone' ? coneBoundaryTouchesApex : undefined,
      edgeTools: edges.length,
      faceIndex,
      faceKey,
      method: successfulMethod,
      resultFaces: countFaces(oc, replacement),
      surfaceType,
      toolFaces: tools.length
    });
    diagnostics.successfulSplits += 1;
    stats.successfulSplits += 1;
  } else {
    failedSplitFaceKeys.add(faceKey);
    diagnostics.failedCandidates.push({
      coneBoundaryTouchesApex: surfaceType === 'cone' ? coneBoundaryTouchesApex : undefined,
      edgeTools: edges.length,
      faceIndex,
      faceKey,
      methodResults,
      reason: 'Face-local OCCT split did not produce replacement faces',
      surfaceTools: tools.length,
      surfaceType
    });
    stats.failedCandidates += 1;
  }

  return {
    diagnostics,
    failedSplitFaceKeys,
    faceIndex,
    faceKey,
    replacement: acceptedReplacement(oc, replacement) ? replacement : null,
    skipped: false,
    surfaceType
  };
}

function splitPrimitiveFacesBySurfacesBatch(oc, shape, draftAngleDegrees) {
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
  const failedSplitFaceKeys = new Set();
  const replacements = [];

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

  function acceptedReplacement(replacement) {
    return replacement && countFaces(oc, replacement) > 1;
  }

  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));
  let faceIndex = 0;

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const face = faceFromExplorer(oc, explorer);
    const faceKey = shapeKey(face, faceIndex);
    const faceSurface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);
    const surfaceType = getSurfaceType(oc, faceSurface);
    const splitSurfaces = primitiveSplitSurfacesForFace(oc, face, draftAngleDegrees);
    const stats = surfaceStats(surfaceType);
    const edges = [];
    const tools = [];
    const methodResults = [];
    let coneBoundaryTouchesApex = false;

    if (splitSurfaces.length === 0) {
      faceIndex += 1;
      continue;
    }

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
      faceIndex,
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
          contourLength: splitSurface.contourLength || null,
          contourMaxTurnRadians: splitSurface.contourMaxTurnRadians || null,
          contourPoints: splitSurface.contourPoints || null,
          contourResampledPoints: splitSurface.contourResampledPoints || null,
          contourToolExtendedPoints: splitSurface.contourToolExtendedPoints || null,
          contourSelfIntersects: splitSurface.contourSelfIntersects || false,
          contourValidationCheckedSamples: splitSurface.contourValidationCheckedSamples || null,
          contourValidationScore: splitSurface.contourValidationScore || null,
          contourValidationUnknownSamples: splitSurface.contourValidationUnknownSamples || null,
          contourValidationValidSamples: splitSurface.contourValidationValidSamples || null,
          rawContourCandidates: splitSurface.rawContourCandidates || null,
          rows: splitSurface.points?.length || 0,
          type: splitSurface.type,
          validatedContourCandidates: splitSurface.validatedContourCandidates || null
        };
      })
    });

    for (const splitSurface of splitSurfaces) {
      const contourEdge = makeContourEdgeFromSplitSurface(oc, splitSurface, face);

      if (contourEdge) {
        edges.push(contourEdge);
        stats.sectionEdges += 1;
      }

      const sectionEdges = sectionFaceWithSplitSurface(oc, face, splitSurface);

      stats.sectionEdges += sectionEdges.length;
      edges.push(...sectionEdges);

      const toolFace = makeToolFaceFromSplitSurface(oc, splitSurface);

      if (toolFace) {
        tools.push(toolFace);
        stats.toolFaces += 1;
      }
    }

    if (surfaceType === 'torus') {
      diagnostics.torusSplits.push({
        faceIndex,
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
      failedSplitFaceKeys.add(faceKey);
      diagnostics.failedCandidates.push({
        faceIndex,
        faceKey,
        reason: 'No section edges or tool faces were produced',
        splitSurfaces: splitSurfaces.length,
        surfaceType
      });
      stats.failedCandidates += 1;
      faceIndex += 1;
      continue;
    }

    diagnostics.totalSplitAttempts += 1;
    let replacement = null;
    const wireGroups = splitEdgeGroupsForWires(oc, edges);

    if (surfaceType === 'cone' && coneBoundaryTouchesApex) {
      const faceDivideResult = tryFaceDivideApexCone(oc, face, face, faceSurface, splitSurfaces);
      replacement = faceDivideResult.shape;
      methodResults.push({
        attempts: faceDivideResult.attempts,
        error: faceDivideResult.error,
        method: 'cone-apex-face-divide-u-split',
        resultFaces: faceDivideResult.resultFaces,
        success: acceptedReplacement(replacement),
        uSplitValues: faceDivideResult.uSplitValues
      });
      diagnostics.apexConeFaceDivide.push({
        attempts: faceDivideResult.attempts,
        bounds: faceDivideResult.bounds,
        error: faceDivideResult.error,
        faceIndex,
        faceKey,
        resultFaces: faceDivideResult.resultFaces,
        success: acceptedReplacement(replacement),
        uSplitValues: faceDivideResult.uSplitValues
      });

      if (!acceptedReplacement(replacement)) {
        replacement = null;
      }
    }

    if (!replacement && wireGroups.length > 0) {
      replacement = trySplitFaceWithWires(oc, face, face, wireGroups.map((group) => group.wire));
      methodResults.push({
        method: 'split-face-wires',
        resultFaces: replacement ? countFaces(oc, replacement) : null,
        success: acceptedReplacement(replacement),
        wireTools: wireGroups.length
      });

      if (!acceptedReplacement(replacement)) {
        replacement = null;
      }
    }

    if (!replacement && wireGroups.length > 0) {
      replacement = trySplitFaceWithWires(oc, face, face, wireGroups.map((group) => group.wire), false);
      methodResults.push({
        method: 'split-face-wires-relaxed-boundary',
        resultFaces: replacement ? countFaces(oc, replacement) : null,
        success: acceptedReplacement(replacement),
        wireTools: wireGroups.length
      });

      if (!acceptedReplacement(replacement)) {
        replacement = null;
      }
    }

    if (!replacement && edges.length > 0) {
      replacement = trySplitFaceWithEdges(oc, face, face, edges);
      methodResults.push({
        method: 'split-face-edges',
        resultFaces: replacement ? countFaces(oc, replacement) : null,
        success: acceptedReplacement(replacement)
      });

      if (!acceptedReplacement(replacement)) {
        replacement = null;
      }
    }

    if (!replacement && edges.length > 0) {
      replacement = trySplitFaceWithEdges(oc, face, face, edges, false);
      methodResults.push({
        method: 'split-face-edges-relaxed-boundary',
        resultFaces: replacement ? countFaces(oc, replacement) : null,
        success: acceptedReplacement(replacement)
      });

      if (!acceptedReplacement(replacement)) {
        replacement = null;
      }
    }

    if (!replacement && (surfaceType === 'torus' || isGeneralSurfaceType(surfaceType)) && tools.length > 0) {
      replacement = tryBooleanSplitShape(oc, face, tools);
      methodResults.push({
        method: `${surfaceType}-face-boolean-tool-split`,
        resultFaces: replacement ? countFaces(oc, replacement) : null,
        success: acceptedReplacement(replacement),
        toolFaces: tools.length
      });

      if (!acceptedReplacement(replacement)) {
        replacement = null;
      }
    }

    if (surfaceType === 'torus') {
      diagnostics.torusSplits.push({
        edgeTools: edges.length,
        faceIndex,
        faceKey,
        methodResults,
        phase: 'candidate-tried',
        resultFaces: replacement ? countFaces(oc, replacement) : null,
        success: acceptedReplacement(replacement),
        toolFaces: tools.length
      });
    }

    if (acceptedReplacement(replacement)) {
      const successfulMethod = methodResults.find((result) => result.success)?.method || null;

      replacements.push({ face, replacement });
      diagnostics.successfulCandidates.push({
        coneBoundaryTouchesApex: surfaceType === 'cone' ? coneBoundaryTouchesApex : undefined,
        edgeTools: edges.length,
        faceIndex,
        faceKey,
        method: successfulMethod,
        resultFaces: countFaces(oc, replacement),
        surfaceType,
        toolFaces: tools.length
      });
      diagnostics.successfulSplits += 1;
      stats.successfulSplits += 1;
    } else {
      failedSplitFaceKeys.add(faceKey);
      diagnostics.failedCandidates.push({
        coneBoundaryTouchesApex: surfaceType === 'cone' ? coneBoundaryTouchesApex : undefined,
        edgeTools: edges.length,
        faceIndex,
        faceKey,
        methodResults,
        reason: 'Face-local OCCT split did not produce replacement faces',
        surfaceTools: tools.length,
        surfaceType
      });
      stats.failedCandidates += 1;
    }

    faceIndex += 1;
  }

  if (replacements.length === 0) {
    return { diagnostics, failedSplitFaceKeys, shape };
  }

  try {
    const reshaper = makeInstance(oc, 'BRepTools_ReShape');

    for (const { face, replacement } of replacements) {
      callAny(reshaper, ['Replace'], [face, replacement]);
    }

    const result = callAny(reshaper, ['Apply'], [shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE')]);
    return {
      diagnostics,
      failedSplitFaceKeys,
      shape: callAny(result, ['IsNull']) ? shape : result
    };
  } catch (error) {
    diagnostics.failedCandidates.push({
      reason: `Batch face replacement failed: ${error.message || String(error)}`,
      replacements: replacements.length
    });

    return { diagnostics, failedSplitFaceKeys, shape };
  }
}

function workerCountForJobs(jobCount, requestedCount) {
  if (jobCount <= 0 || typeof Worker === 'undefined') {
    return 0;
  }

  const hardwareCount = typeof navigator !== 'undefined' && Number.isFinite(navigator.hardwareConcurrency)
    ? navigator.hardwareConcurrency
    : 4;
  const defaultCount = Math.max(1, Math.min(8, hardwareCount - 1 || 1));
  return Math.max(1, Math.min(jobCount, requestedCount || defaultCount));
}

const WORKER_RENDER_INTERVAL_MS = 250;
let preloadedWorkerPool = null;

function rotationKey(rotation = {}) {
  return JSON.stringify({
    x: Number(rotation.x) || 0,
    y: Number(rotation.y) || 0,
    z: Number(rotation.z) || 0
  });
}

function readStepShapeWithRotation(oc, buffer, rotation = {}) {
  return rotateShape(oc, readStepShape(oc, buffer), rotation);
}

function terminateWorkerPool(pool) {
  for (const entry of pool?.workers || []) {
    entry.worker.terminate();
  }
}

export async function terminatePreloadedStepWorkers() {
  if (preloadedWorkerPool) {
    terminateWorkerPool(preloadedWorkerPool);
    preloadedWorkerPool = null;
  }
}

export async function preloadStepWorkers(buffer, options = {}) {
  if (typeof Worker === 'undefined') {
    return { workers: 0 };
  }

  const preloadRotationKey = rotationKey(options.rotation);

  if (preloadedWorkerPool?.buffer === buffer && preloadedWorkerPool.rotationKey === preloadRotationKey) {
    await preloadedWorkerPool.readyPromise;
    return { workers: preloadedWorkerPool.workers.length };
  }

  await terminatePreloadedStepWorkers();

  const oc = await getOpenCascade();
  const shape = readStepShapeWithRotation(oc, buffer, options.rotation);
  const jobs = collectFaceJobs(oc, shape);
  const workerCount = workerCountForJobs(jobs.length, options.workerCount);

  if (workerCount === 0) {
    return { workers: 0 };
  }

  const pool = {
    buffer,
    busy: false,
    rotationKey: preloadRotationKey,
    workers: []
  };

  pool.readyPromise = Promise.all(Array.from({ length: workerCount }, () => new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./occtWorker.js', import.meta.url));
    const entry = { worker };
    pool.workers.push(entry);

    function cleanup() {
      worker.removeEventListener('message', handleMessage);
      worker.removeEventListener('error', handleError);
    }

    function handleMessage(event) {
      const message = event.data || {};

      if (message.type === 'ready') {
        cleanup();
        resolve(entry);
      } else if (message.type === 'error') {
        cleanup();
        reject(new Error(message.error || 'OCCT worker failed during preload.'));
      }
    }

    function handleError(error) {
      cleanup();
      reject(error.error || new Error(error.message || 'OCCT worker failed during preload.'));
    }

    worker.addEventListener('message', handleMessage);
    worker.addEventListener('error', handleError);
    worker.postMessage({
      buffer,
      rotation: options.rotation,
      type: 'init'
    });
  })));

  preloadedWorkerPool = pool;

  try {
    await pool.readyPromise;
  } catch (error) {
    if (preloadedWorkerPool === pool) {
      preloadedWorkerPool = null;
    }

    terminateWorkerPool(pool);
    throw error;
  }

  return { workers: workerCount };
}

async function splitPrimitiveFacesWithWorkers(oc, shape, buffer, draftAngleDegrees, options = {}) {
  const jobs = collectFaceJobs(oc, shape);
  const workerCount = workerCountForJobs(jobs.length, options.workerCount);

  if (workerCount === 0) {
    return splitPrimitiveFacesBySurfacesBatch(oc, shape, draftAngleDegrees);
  }

  let borrowedPool = null;
  let borrowedWorkers = null;

  const splitRotationKey = rotationKey(options.rotation);

  if (
    preloadedWorkerPool?.buffer === buffer &&
    preloadedWorkerPool.rotationKey === splitRotationKey &&
    !preloadedWorkerPool.busy
  ) {
    try {
      await preloadedWorkerPool.readyPromise;
      borrowedPool = preloadedWorkerPool;
      borrowedWorkers = borrowedPool.workers.map((entry) => entry.worker);
      borrowedPool.busy = true;
    } catch {
      borrowedPool = null;
      borrowedWorkers = null;
    }
  }

  const diagnostics = createSplitDiagnostics();
  const failedSplitFaceKeys = new Set();
  const replacements = new Map();
  let streamedReplacementCount = 0;
  let nextJobIndex = 0;
  let completedJobs = 0;
  let activeWorkers = 0;
  let settled = false;

  return new Promise((resolve, reject) => {
    const workers = borrowedWorkers || [];
    const workerHandlers = [];
    const renderTimer = setInterval(() => {
      try {
        if (settled || replacements.size === streamedReplacementCount) {
          return;
        }

        const snapshotShape = readStepShapeWithRotation(oc, buffer, options.rotation);
        const snapshotFaces = collectFaces(oc, snapshotShape);
        const currentShape = applyReplacementMap(oc, snapshotShape, snapshotFaces, replacements);

        streamedReplacementCount = replacements.size;
        options.onProgress?.({
          completedFaces: completedJobs,
          currentShape,
          replacementFaces: replacements.size,
          totalFaces: jobs.length,
          workers: workerCount
        });
      } catch (error) {
        settled = true;
        cleanup();
        reject(error);
      }
    }, WORKER_RENDER_INTERVAL_MS);

    function cleanup() {
      clearInterval(renderTimer);

      for (const { handleError, handleMessage, worker } of workerHandlers) {
        worker.removeEventListener('message', handleMessage);
        worker.removeEventListener('error', handleError);
      }

      if (borrowedPool) {
        borrowedPool.busy = false;
      } else {
        for (const worker of workers) {
          worker.terminate();
        }
      }
    }

    function finishIfDone() {
      if (settled || completedJobs < jobs.length || activeWorkers > 0) {
        return;
      }

      settled = true;
      cleanup();

      const finalBaseShape = readStepShapeWithRotation(oc, buffer, options.rotation);
      const finalFaces = collectFaces(oc, finalBaseShape);
      const finalShape = applyReplacementMap(oc, finalBaseShape, finalFaces, replacements);
      options.onProgress?.({
        completedFaces: completedJobs,
        replacementFaces: replacements.size,
        totalFaces: jobs.length,
        workers: workerCount
      });
      resolve({
        diagnostics,
        failedSplitFaceKeys,
        shape: finalShape
      });
    }

    function assignJob(worker) {
      if (settled) {
        return;
      }

      const job = jobs[nextJobIndex];

      if (!job) {
        worker.postMessage({ type: 'idle' });
        finishIfDone();
        return;
      }

      nextJobIndex += 1;
      activeWorkers += 1;
      worker.postMessage({
        draftAngleDegrees,
        faceIndex: job.faceIndex,
        jobId: job.faceIndex,
        type: 'process-face'
      });
    }

    function handleWorkerResult(worker, message) {
      activeWorkers -= 1;
      completedJobs += 1;

      if (message.diagnostics) {
        mergeSplitDiagnostics(diagnostics, message.diagnostics);
      }

      for (const faceKey of message.failedFaceKeys || []) {
        failedSplitFaceKeys.add(faceKey);
      }

      if (message.brepText) {
        const replacement = readBrepShape(oc, message.brepText);
        replacements.set(message.faceIndex, replacement);
      }

      options.onProgress?.({
        completedFaces: completedJobs,
        lastFaceIndex: message.faceIndex,
        lastSurfaceType: message.surfaceType,
        replacementFaces: replacements.size,
        totalFaces: jobs.length,
        workers: workerCount
      });
      assignJob(worker);
      finishIfDone();
    }

    function attachWorker(worker, initialize) {
      function handleMessage(event) {
        const message = event.data || {};

        if (settled) {
          return;
        }

        if (message.type === 'ready') {
          assignJob(worker);
          return;
        }

        if (message.type === 'result') {
          try {
            handleWorkerResult(worker, message);
          } catch (error) {
            settled = true;
            cleanup();
            reject(error);
          }
          return;
        }

        if (message.type === 'error') {
          settled = true;
          cleanup();
          reject(new Error(message.error || 'OCCT worker failed.'));
        }
      }

      function handleError(error) {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();
        reject(error.error || new Error(error.message || 'OCCT worker failed.'));
      }

      worker.addEventListener('message', handleMessage);
      worker.addEventListener('error', handleError);
      workerHandlers.push({ handleError, handleMessage, worker });

      if (initialize) {
        worker.postMessage({
          buffer,
          rotation: options.rotation,
          type: 'init'
        });
      } else {
        assignJob(worker);
      }
    }

    if (borrowedWorkers) {
      for (const worker of borrowedWorkers) {
        attachWorker(worker, false);
      }
    } else {
      for (let index = 0; index < workerCount; index += 1) {
        const worker = new Worker(new URL('./occtWorker.js', import.meta.url));
        workers.push(worker);
        attachWorker(worker, true);
      }
    }
  });
}

export async function createStepFaceProcessor(buffer, options = {}) {
  const oc = await getOpenCascade();
  const shape = readStepShapeWithRotation(oc, buffer, options.rotation);

  return {
    processFace(faceIndex, draftAngleDegrees) {
      const face = faceAtIndex(oc, shape, faceIndex);

      if (!face) {
        throw new Error(`Worker could not find face index ${faceIndex}.`);
      }

      const result = splitSingleFaceBySurfaces(oc, face, face, faceIndex, draftAngleDegrees);
      const brepText = result.replacement ? writeBrepShape(oc, result.replacement) : null;

      return {
        brepText,
        diagnostics: result.diagnostics,
        faceIndex,
        faceKey: result.faceKey,
        failedFaceKeys: Array.from(result.failedSplitFaceKeys),
        skipped: result.skipped,
        surfaceType: result.surfaceType
      };
    }
  };
}

function buildRenderModelFromShape(oc, shape, splitResult, splitStepText = null, options = {}) {
  return buildRenderModelFromShapeCore(oc, shape, splitResult, splitStepText, options, {
    callAny,
    dereferenceHandle,
    edgeFromExplorer,
    enumValue,
    faceFromExplorer,
    getCoord,
    makeExplorer,
    makeInstance,
    normalFromDerivatives,
    pointToArray,
    shapeOrientation,
    statusValue,
    tryCallAnyArgs
  });
}

export async function loadStepWithOpenCascade(buffer, draftAngleDegrees, options = {}) {
  const oc = await getOpenCascade();
  let shape = readStepShapeWithRotation(oc, buffer, options.rotation);
  options.onInitialModel?.(buildRenderModelFromShape(oc, shape, {
    diagnostics: createSplitDiagnostics()
  }));

  let splitResult;

  if (options.useWorkers !== false && typeof Worker !== 'undefined') {
    try {
      splitResult = await splitPrimitiveFacesWithWorkers(oc, shape, buffer, draftAngleDegrees, {
        ...options,
        onProgress: (progress) => {
          options.onProgress?.(progress);

          if (progress.currentShape && options.onPartialModel) {
            options.onPartialModel(buildRenderModelFromShape(oc, progress.currentShape, {
              diagnostics: createSplitDiagnostics()
            }, null, {
              classifyDraftFaces: true,
              draftAngleDegrees
            }));
          }
        }
      });
    } catch (error) {
      console.warn('Worker-based OCCT splitting failed; falling back to single-thread batch split.', error);
      splitResult = splitPrimitiveFacesBySurfacesBatch(oc, shape, draftAngleDegrees);
    }
  } else {
    splitResult = splitPrimitiveFacesBySurfacesBatch(oc, shape, draftAngleDegrees);
  }

  shape = splitResult.shape;
  const splitStepText = writeStepShape(oc, shape);
  return buildRenderModelFromShape(oc, shape, splitResult, splitStepText, {
    classifyDraftFaces: true,
    draftAngleDegrees
  });
}

export async function loadStepPreviewWithOpenCascade(buffer, options = {}) {
  const oc = await getOpenCascade();
  const shape = readStepShapeWithRotation(oc, buffer, options.rotation);

  return buildRenderModelFromShape(oc, shape, {
    diagnostics: createSplitDiagnostics()
  });
}
