import { compose, rotation, translation, type Matrix } from '../model/transform';
import type { NestPlacement } from './types';

/** The transform that moves a part's source geometry to its nested position. */
export function placementMatrix(placement: Pick<NestPlacement, 'rotationDeg' | 'dx' | 'dy'>): Matrix {
  const turn = rotation((placement.rotationDeg * Math.PI) / 180, { x: 0, y: 0 });
  return compose(translation(placement.dx, placement.dy), turn);
}
