import {
  AdditiveBlending,
  type Blending,
  type BlendingDstFactor,
  type BlendingSrcFactor,
  CustomBlending,
  DstColorFactor,
  NormalBlending,
  OneFactor,
  OneMinusSrcAlphaFactor,
  SrcAlphaFactor,
  SrcColorFactor,
  ZeroFactor,
} from 'three';

import type { EffectBlend } from '../utils/m2-tracks';

// A blend's factors as the client sets them, for any model material
// (effects, units, props): add by alpha, add, modulate, modulate 2x, or
// normal.
export function blendFactors(blend: EffectBlend): { blending: Blending; blendSrc: BlendingSrcFactor; blendDst: BlendingDstFactor } {
  const custom = (blendSrc: BlendingSrcFactor, blendDst: BlendingDstFactor) => ({ blending: CustomBlending, blendSrc, blendDst });
  switch (blend) {
    case 'add': return { blending: AdditiveBlending, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor };
    case 'addColor': return custom(OneFactor, OneFactor);
    case 'mod': return custom(DstColorFactor, ZeroFactor);
    case 'mod2x': return custom(DstColorFactor, SrcColorFactor);
    default: return { blending: NormalBlending, blendSrc: SrcAlphaFactor, blendDst: OneMinusSrcAlphaFactor };
  }
}
