import type { Provider, ProviderModel } from '@canvora/shared';

/**
 * 生成节点的可选模型来自后端已配置的服务商，前端不允许手填服务商或模型。
 * 这里只做「按能力筛出可用项」和「解析当前选中项」两件事，两侧（节点渲染与发起生成）共用，
 * 避免渲染时看到的模型和实际提交的模型不一致。
 */

export const IMAGE_CAPABILITIES = ['text2image', 'image2image', 'imageEdit'];
export const VIDEO_CAPABILITIES = ['text2video', 'image2video', 'firstLastFrame'];

export type GenerationKind = 'image' | 'video';

export interface GenerationTarget {
  provider: Provider;
  model: ProviderModel;
}

function capabilitiesFor(kind: GenerationKind): string[] {
  return kind === 'video' ? VIDEO_CAPABILITIES : IMAGE_CAPABILITIES;
}

export function modelSupports(model: ProviderModel, kind: GenerationKind): boolean {
  return model.capabilities.some((capability) => capabilitiesFor(kind).includes(capability));
}

/** 某个生成节点真正能用的服务商与模型组合，已禁用或能力不匹配的不会出现。 */
export function generationTargets(providers: Provider[], kind: GenerationKind): GenerationTarget[] {
  const targets: GenerationTarget[] = [];
  for (const provider of providers) {
    if (!provider.enabled) continue;
    for (const model of provider.models) {
      if (modelSupports(model, kind)) targets.push({ provider, model });
    }
  }
  return targets;
}

/** 用节点里保存的 id 找回组合；找不到就退回第一个可用项，保证「看到的」和「提交的」一致。 */
export function resolveGenerationTarget(
  providers: Provider[],
  kind: GenerationKind,
  providerId?: string,
  modelId?: string,
): GenerationTarget | null {
  const targets = generationTargets(providers, kind);
  if (!targets.length) return null;
  return targets.find((item) => item.provider.id === providerId && item.model.id === modelId)
    ?? targets.find((item) => item.provider.id === providerId)
    ?? targets[0];
}

export const IMAGE_SIZES = ['1024x1024', '1280x720', '720x1280', '1024x768'];
export const VIDEO_ASPECTS = ['16:9', '9:16', '1:1'];
export const VIDEO_DURATIONS = ['5', '10'];
export const IMAGE_COUNTS = ['1', '2', '4'];

/** 生成节点的参数集合：不同模型支持的键不一样，多余键由服务商适配层忽略。 */
export function buildGenerationParams(kind: GenerationKind, data: Record<string, unknown>): Record<string, unknown> {
  if (kind === 'image') {
    return { size: String(data.size ?? IMAGE_SIZES[0]), n: Number(data.count ?? 1) };
  }
  return { aspect_ratio: String(data.aspect ?? VIDEO_ASPECTS[0]), duration: String(data.duration ?? VIDEO_DURATIONS[0]) };
}
