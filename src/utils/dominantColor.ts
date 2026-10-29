import { useEffect, useState } from 'react';
import { coverSrc } from './media';

// 从封面里取一个「招牌色」，文件夹卡用它给整张卡上色（书脊、辉光、角标等），
// 于是每个文件夹在网格里一眼可辨 —— 这是文件夹卡唯一不能靠排版拿到的信息。
// 取不到（无封面 / 解码失败 / 图太灰）就回落到主题青色。
//
// 返回的是 CSS 变量值（"190 100% 50%"），不是完整颜色：卡片里要用它派生出十几个不同透明度的
// 色（边框、辉光、渐变遮罩），写成 `hsl(var(--fc) / .35)` 最省事，也不用为每种透明度建变量。

const FALLBACK = '190 100% 50%'; // = #00d4ff（--color-accent）
const cache = new Map<string, string>();

export function useFolderAccent(path: string): string {
  const [color, setColor] = useState(() => (path ? cache.get(path) ?? FALLBACK : FALLBACK));
  useEffect(() => {
    if (!path) { setColor(FALLBACK); return; }
    const hit = cache.get(path);
    if (hit) { setColor(hit); return; }
    let alive = true;
    void dominantColor(path).then((c) => {
      cache.set(path, c);
      if (alive) setColor(c);
    });
    return () => { alive = false; };
  }, [path]);
  return color;
}

/** 封面 → "H S% L%"（CSS 变量值）。取不到返回兜底色 */
async function dominantColor(path: string): Promise<string> {
  try {
    // fetch 而不是直接 <img>：封面走的是 covers 自定义协议，fetch 拿 blob 再解码能绕开
    // 画布污染（跨源图直接 drawImage 会让 getImageData 抛异常）。这条链路 CoverImg 已经在用，
    // 拿到的字节还会命中 HTTP 缓存，等于零额外开销
    const resp = await fetch(coverSrc(path));
    if (!resp.ok) return FALLBACK;
    const bitmap = await createImageBitmap(await resp.blob());
    const S = 32;
    const canvas = document.createElement('canvas');
    canvas.width = S;
    canvas.height = S;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return FALLBACK;
    ctx.drawImage(bitmap, 0, 0, S, S);
    bitmap.close();
    const { data } = ctx.getImageData(0, 0, S, S);

    // 只统计「有颜色」的像素，权重按饱和度平方：封面上大面积的暗部与灰调会把简单平均
    // 拉成一坨脏灰，而文件夹的招牌色要的是那抹最鲜的色
    let r = 0, g = 0, b = 0, w = 0;
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i], G = data[i + 1], B = data[i + 2];
      const mx = Math.max(R, G, B);
      const mn = Math.min(R, G, B);
      if (mx < 48 || mn > 232) continue;               // 近黑 / 近白都不是"色"
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      if (sat < 0.18) continue;                        // 灰调不要
      const weight = sat * sat;
      r += R * weight; g += G * weight; b += B * weight; w += weight;
    }
    if (w === 0) return FALLBACK;
    return tune(r / w, g / w, b / w);
  } catch {
    return FALLBACK;
  }
}

/** 把平均色拉成"能当招牌用"的一档：饱和度抬起来、亮度收进中段 */
function tune(r: number, g: number, b: number): string {
  const [h, s, l] = rgbToHsl(r, g, b);
  const S = Math.round(Math.min(0.88, Math.max(0.52, s * 1.25)) * 100);
  const L = Math.round(Math.min(0.62, Math.max(0.44, l)) * 100);
  return `${Math.round(h)} ${S}% ${L}%`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === R) h = ((G - B) / d + (G < B ? 6 : 0));
  else if (mx === G) h = (B - R) / d + 2;
  else h = (R - G) / d + 4;
  return [h * 60, s, l];
}
