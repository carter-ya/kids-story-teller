import {ApiError, requireValue} from './common.mjs';

// Estimate spoken Chinese characters and English words, excluding layout and punctuation.
const unitsPerMinute = 180;
const minutesPerChapter = 5;
const unitCount = text => (text.match(/[\p{Script=Latin}\p{N}]+|\p{L}/gu) || []).length;
const mentionsDuration = input => /分钟|小时|钟头|刻钟|时长|半天|\b(?:hours?|minutes?|hrs?|mins?)\b/i.test(input);
// Handle explicit numeric playback targets locally. Let the writer interpret other
// time expressions, e.g. “一个半小时” or a wait that belongs only to the plot.
function explicitMinutes(input) {
  const compact = input.normalize('NFKC').replace(/\s+/g, '');
  const match = /(?:播放时长|朗读时长|故事时长|目标时长|总时长|时长)(?:约为|大约|约|为|是|:)?(\d+(?:\.\d+)?)(?:个)?(小时|分钟)(?:左右)?(?=$|[，,。；;！!?？]|的故事)/.exec(compact);
  return match ? Number(match[1]) * (match[2] === '小时' ? 60 : 1) : null;
}

export function writingReserve(input, plannedChapters = 0) {
  const minutes = explicitMinutes(input);
  const count = plannedChapters || (minutes === null ? 1 : targetFor(minutes).count);
  // Allow four UTF-8 bytes per character, including headings and the saved outline.
  return Math.max(64000, 4 * (Math.min(60000, count * 4064) + count * 400 + 64));
}

function targetFor(minutes) {
  requireValue(Number.isFinite(minutes) && minutes > 0 && minutes <= 240, 400, '单部故事的目标时长须大于零且不超过 4 小时。');
  const count = Math.ceil(minutes / minutesPerChapter);
  return {minutes, count, units:Math.max(1, Math.round(minutes * unitsPerMinute / count))};
}

const validTitle = title => typeof title === 'string' && !!title.trim() && [...title.trim()].length <= 24 && !/[\r\n]/.test(title.trim());
const invalid = () => new ApiError(502, '写作模型返回的标题或故事格式不完整，请重试。');
function readObject(raw) {
  try { return JSON.parse(raw.replace(/^\x60\x60\x60(?:json)?\s*|\s*\x60\x60\x60$/gi, '').trim()); }
  catch { throw invalid(); }
}

export async function writeStep(job, complete) {
  if (job.kind === 'rewrite') {
    return {text:await complete('按照家长的修改要求润色儿童故事的这一段。只输出替换用的一个段落，保持人物、事实和人称一致，避免惊吓。')};
  }
  const outline = job.outline ? JSON.parse(job.outline) : null;
  let minutes = outline?.minutes ?? explicitMinutes(job.input);
  if (minutes === null && mentionsDuration(job.input)) {
    const intent = readObject(await complete('提取家长要求的整部故事的实际朗读时长。换算为分钟，区间取中点。剧情内经过的时间和孩子年龄不算朗读时长。只输出 JSON 对象 {"minutes":数字}；未要求具体朗读时长则填 null。', '', 'intent'));
    if (!intent || (intent.minutes !== null && !Number.isFinite(intent.minutes))) throw invalid();
    minutes = intent.minutes;
  }
  const target = minutes === null ? null : targetFor(minutes);
  const directions = '为孩子创作可直接朗读的中文故事。遵守家长指定的年龄、场景、外语词汇和叙事要求，避免惊吓、暴力和私人联系方式。';
  const naming = '根据实际剧情拟一个简短、有辨识度的书名，建议 4 至 16 个字，最多 24 个字符。';
  if (target?.count > 1 && !job.outline) {
    const plan = readObject(await complete(directions + naming + '先规划全书，输出 JSON 对象 {"title":"书名","chapters":[{"title":"章名","scene":"本章场景、情节及承接"}]}。' +
      '朗读目标约 ' + target.minutes + ' 分钟，恰好规划 ' + target.count + ' 章。章名不带编号，最多 24 字。每章用一句话规划独立场景，前后连贯，最后一章收束。', '', 'outline'));
    if (!validTitle(plan?.title) || !Array.isArray(plan.chapters) || plan.chapters.length !== target.count ||
      !plan.chapters.every(ch => validTitle(ch?.title) && typeof ch.scene === 'string' && ch.scene.trim() && ch.scene.length <= 300)) throw invalid();
    return {title:plan.title.trim(), outline:{minutes,chapters:plan.chapters.map(ch => ({title:ch.title.trim(), scene:ch.scene.trim()}))}};
  }

  const chapters = outline?.chapters;
  const chapter = chapters?.[job.completed];
  const shape = chapter ? '只输出本章可朗读的正文，分段，不重复书名或章名。' :
    naming + '输出 JSON 对象 {"title":"书名","text":"分段的故事正文"}。';
  const context = chapter ? '\n书名：' + job.story_title + '\n全书大纲：' + JSON.stringify(chapters) +
    '\n现在写第 ' + (job.completed + 1) + ' 章《' + chapter.title + '》。\n上章结尾：' + (job.result.slice(-450) || '全书开篇') : '';
  const length = target ? '本次正文目标约 ' + target.units + ' 个朗读字（英文单词按一个字计），用具体行动和对话展开情节。' : '根据家长要求安排篇幅，未指定时写一篇完整短故事。';
  let feedback = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await complete(directions + shape + length, context + feedback, attempt ? 'revising' : 'drafting');
    const story = chapter ? {text:raw} : readObject(raw);
    if ((!chapter && !validTitle(story?.title)) || typeof story?.text !== 'string' || !story.text.trim()) throw invalid();
    const text = story.text.trim();
    const size = unitCount(text);
    if (!target || (size >= Math.floor(target.units * 0.85) && size <= Math.ceil(target.units * 1.15) && text.length <= Math.min(4000, Math.floor(60000 / target.count) - 64))) {
      return chapter ? {text} : {title:story.title.trim(), text};
    }
    feedback = '\n上一稿实际为 ' + size + ' 个朗读字。请根据原稿调整场景和对话，重新输出完整正文，靠近 ' + target.units + ' 字。\n原稿：' + text;
  }
  throw new ApiError(502, '模型连续两次未达到本段目标篇幅，请重试。');
}
