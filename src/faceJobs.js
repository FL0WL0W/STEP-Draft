import { callAny, enumValue, makeInstance } from './occtRuntime.js';
import { faceFromExplorer, makeExplorer, shapeKey } from './shapeTraversal.js';
import { getSurfaceType } from './surfaceAnalysis.js';

export function faceAtIndex(oc, shape, targetIndex) {
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));
  let faceIndex = 0;

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const face = faceFromExplorer(oc, explorer);

    if (faceIndex === targetIndex) {
      return face;
    }

    faceIndex += 1;
  }

  return null;
}

export function collectFaceJobs(oc, shape) {
  const jobs = [];
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));
  let faceIndex = 0;

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    const face = faceFromExplorer(oc, explorer);
    const faceSurface = makeInstance(oc, 'BRepAdaptor_Surface', [face, true]);
    const surfaceType = getSurfaceType(oc, faceSurface);

    jobs.push({
      faceIndex,
      faceKey: shapeKey(face, faceIndex),
      surfaceType
    });
    faceIndex += 1;
  }

  const priority = {
    bspline: 0,
    bezier: 0,
    torus: 1,
    cone: 2,
    cylinder: 3,
    sphere: 3,
    plane: 4,
    generic: 5
  };

  return jobs.sort((left, right) => (
    (priority[left.surfaceType] ?? 10) - (priority[right.surfaceType] ?? 10) ||
    left.faceIndex - right.faceIndex
  ));
}

export function applyReplacementMap(oc, shape, faces, replacements) {
  if (replacements.size === 0) {
    return shape;
  }

  const reshaper = makeInstance(oc, 'BRepTools_ReShape');

  for (const [faceIndex, replacement] of replacements.entries()) {
    const face = faces[faceIndex];

    if (face) {
      callAny(reshaper, ['Replace'], [face, replacement]);
    }
  }

  const result = callAny(reshaper, ['Apply'], [shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE')]);
  return callAny(result, ['IsNull']) ? shape : result;
}

export function collectFaces(oc, shape) {
  const faces = [];
  const explorer = makeExplorer(oc, shape, enumValue(oc, 'TopAbs_ShapeEnum', 'TopAbs_FACE'));

  for (; callAny(explorer, ['More']); callAny(explorer, ['Next'])) {
    faces.push(faceFromExplorer(oc, explorer));
  }

  return faces;
}
