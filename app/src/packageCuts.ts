import { cutKeyFor, type CutStep } from './instructions';
import type { PackageSheet, PackageData } from './packageData';

/** Same physical conventions as the job PDF: quote the selected kerf reference. */
export function cutMeasurement(step: CutStep, sheet: PackageSheet, data: Pick<PackageData, 'kerf' | 'kerfRef'>) {
  const vertical = sheet.length >= sheet.width ? step.axis === 'rip' : step.axis === 'cross';
  const span = vertical ? step.parentW : step.parentH;
  const allowance = data.kerfRef === 'keeper' ? data.kerf : data.kerfRef === 'spacing' ? data.kerf / 2 : 0;
  const reference = step.measureFromCut ? sheet.steps.find(s => cutKeyFor(s) === step.measureFromCut) : undefined;
  let distance: number;
  if (step.isTrim) distance = Math.min(step.distance, span - step.distance);
  else if (reference) {
    const refVertical = sheet.length >= sheet.width ? reference.axis === 'rip' : reference.axis === 'cross';
    distance = Math.max(0, Math.abs((vertical ? step.parentX : step.parentY) + step.distance
      - ((refVertical ? reference.parentX : reference.parentY) + reference.distance)) - allowance);
  } else distance = Math.max(0, (step.fromFar ? span - step.distance : step.distance) - allowance);
  const fromFar = step.isTrim ? step.distance > span / 2 : step.fromFar;
  const from = reference && !step.isTrim ? `cut ${reference.index}` : vertical ? (fromFar ? 'right edge' : 'left edge') : (fromFar ? 'bottom edge' : 'top edge');
  return { vertical, distance, from };
}
