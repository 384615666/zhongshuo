/**
 * 预设头像清单。
 *
 * 9 张图是同一套画风的 Q 版 AI 娘大头照（扁平粉彩、超近特写、人物朝画面右侧、
 * 背景 #EDEAF4），由本机 ComfyUI 的 Qwen-Image 2.1 生成，源文件与说明见
 * `D:\zhongshuo\dist\ai-avatars\`（不入库）。
 *
 * 图片以 dataurl loader 打进 renderer 包，所以这里的 `dataUrl` 直接就是
 * `app.appearance.set` 能接受的格式，不需要再读文件或转码。
 */
import claude from '../assets/avatars/claude.png';
import codex from '../assets/avatars/codex.png';
import deepseek from '../assets/avatars/deepseek.png';
import pi from '../assets/avatars/pi.png';
import glm from '../assets/avatars/glm.png';
import qwen from '../assets/avatars/qwen.png';
import kimi from '../assets/avatars/kimi.png';
import minimax from '../assets/avatars/minimax.png';
import gemini from '../assets/avatars/gemini.png';

export interface AvatarPreset {
  /** 稳定标识：也用于判断"当前头像是哪张预设"。 */
  id: string;
  label: string;
  dataUrl: string;
}

export const AVATAR_PRESETS: AvatarPreset[] = [
  { id: 'deepseek', label: 'DeepSeek 娘', dataUrl: deepseek },
  { id: 'claude', label: 'Claude 娘', dataUrl: claude },
  { id: 'codex', label: '白龙娘', dataUrl: codex },
  { id: 'kimi', label: 'Kimi 娘', dataUrl: kimi },
  { id: 'qwen', label: '千问娘', dataUrl: qwen },
  { id: 'glm', label: '智谱 GLM 娘', dataUrl: glm },
  { id: 'minimax', label: '海螺娘', dataUrl: minimax },
  { id: 'gemini', label: 'Gemini 娘', dataUrl: gemini },
  { id: 'pi', label: 'Pi 娘', dataUrl: pi },
];

/** 新建 AI 成员时默认使用的那张。 */
export const DEFAULT_AI_AVATAR_PRESET_ID = 'deepseek';

export function findAvatarPreset(id: string): AvatarPreset | undefined {
  return AVATAR_PRESETS.find((preset) => preset.id === id);
}

export function defaultAiAvatarPreset(): AvatarPreset {
  const preset = findAvatarPreset(DEFAULT_AI_AVATAR_PRESET_ID) ?? AVATAR_PRESETS[0];
  if (preset == null) throw Error('预设头像清单为空');
  return preset;
}

/** 当前 dataUrl 对应哪张预设（不是预设=用户上传的图）。 */
export function presetForDataUrl(dataUrl: string | null | undefined): AvatarPreset | undefined {
  if (dataUrl == null) return undefined;
  return AVATAR_PRESETS.find((preset) => preset.dataUrl === dataUrl);
}
