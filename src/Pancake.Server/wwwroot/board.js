/* 大屏外观渲染：网页设置预览与大屏使用同样的结构、尺寸、颜色、字体和图标。
 * 所有尺寸都按大屏的 DIP 书写（磁贴边框 3、圆角 3、内边距 14/10、时钟 112 号字……），
 * 场景按设计尺寸排好后整体缩放到预览框，和大屏设置页的 Viewbox 预览一致。
 * 依赖 app.js 中的 esc / rtNormalize。 */
'use strict';

const Board = (() => {
  // ---------- 主题与色系（Services/BoardTheme.cs、ColorPalette.cs、Themes/ThemeResources.xaml）
  const VIVID = ['#4ADE80', '#818CF8', '#60A5FA', '#FBBF24', '#F472B6', '#2DD4BF', '#F87171', '#65D46E', '#7567FF'];
  const MACARON = ['#A8D5BA', '#BCBCE3', '#AECBE8', '#E8D5A5', '#E3B6D0', '#A5D5CF', '#E5B3B3', '#B0D5B4', '#BEB5E8'];
  const GLYPH = { Edit: '', Settings: '', FullScreen: '', Weather: '', Microphone: '' };
  const WEEK = '日一二三四五六';

  function theme(doc) {
    const t = doc.Theme || 'Dark';
    const light = t === 'Light' || (t === 'Default' && !matchMedia('(prefers-color-scheme: dark)').matches);
    return light
      ? { light, text: '#000000', surface: '#FFFFFF', line: '#D7D7D7', warn: '#B45309', ok: '#15803D', chip: '#F0F0F6', macaron: doc.Palette === 'Macaron' }
      : { light, text: '#F7F7F9', surface: '#1F1F1F', line: '#46464A', warn: '#FBBF24', ok: '#4ADE80', chip: '#262632', macaron: doc.Palette === 'Macaron' };
  }

  /** 预设色在两种色系间一一对应；自定义颜色保持原样。 */
  function palette(hex, macaron) {
    if (typeof hex !== 'string') return hex;
    const up = hex.toUpperCase();
    let i = VIVID.indexOf(up); if (i < 0) i = MACARON.indexOf(up);
    return i < 0 ? hex : (macaron ? MACARON : VIVID)[i];
  }
  const isPreset = hex => typeof hex === 'string' && (VIVID.includes(hex.toUpperCase()) || MACARON.includes(hex.toUpperCase()));
  const accent = (hex, explicit, macaron) => explicit && !isPreset(hex) ? hex : palette(hex, macaron);

  /** #AARRGGBB / #RRGGBB → [r,g,b,a(0-1)]。 */
  function rgba(hex, fallback) {
    const m = typeof hex === 'string' && /^#([0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
    if (!m) return fallback ? rgba(fallback) : null;
    const h = m[1].length === 8 ? m[1] : 'FF' + m[1];
    return [parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), parseInt(h.slice(6, 8), 16), parseInt(h.slice(0, 2), 16) / 255];
  }
  const css = ([r, g, b, a]) => `rgba(${r},${g},${b},${+a.toFixed(4)})`;

  /** Controls/SurfaceBackground.cs：颜色乘以不透明度，清除后完全透明；空颜色用主题底色。 */
  function surfaceTint(color, opacity, cleared, t) {
    const c = rgba(color, t.surface);
    const alpha = Number.isFinite(+opacity) ? Math.min(1, Math.max(0, +opacity)) : .8;
    c[3] = cleared ? 0 : c[3] * alpha;
    return css(c);
  }
  /** 控制窗、组件卡的面板背景：毛玻璃时颜色层叠在模糊之上。 */
  function surfaceStyle(color, opacity, cleared, glass, blur, t) {
    const tint = surfaceTint(color, opacity, cleared, t);
    return glass ? `background:${tint};backdrop-filter:blur(${Math.max(0, +blur || 0)}px);-webkit-backdrop-filter:blur(${Math.max(0, +blur || 0)}px)` : `background:${tint}`;
  }

  // ---------- 背景层（Controls/BackgroundVisual.cs）
  const ASSET = /^asset:([0-9a-f]{64})(\.[a-z0-9]{1,10})?$/i;
  const VIDEO = /^\.(mp4|webm|mov|m4v|mkv|avi|wmv)$/i;
  const FIT = { Stretch: 'fill', Fit: 'contain' };

  function media(path, mode, ctx) {
    if (!path) return '';
    const m = ASSET.exec(path);
    if (!m || !ctx.assetUrl) return `<div class="pk-local" title="${esc(path)}"><span>大屏本地文件</span></div>`;
    const src = esc(ctx.assetUrl(m[1].toLowerCase()));
    const fit = ctx.cover ? 'cover' : FIT[mode] || 'cover';
    return VIDEO.test(m[2] || '')
      ? `<video class="pk-media" data-keep="${src}" src="${src}" style="object-fit:${fit}" muted autoplay loop playsinline></video>`
      : `<img class="pk-media" src="${src}" style="object-fit:${fit}" alt="" draggable="false">`;
  }

  /**
   * 区域背景：颜色垫底（空颜色用主题底色，共享区域与无颜色毛玻璃透明），媒体铺在颜色之上，
   * 毛玻璃时再叠一层模糊和 14% 的黑/白色调。surface 为面板背景（磁贴）：颜色按不透明度合成，毛玻璃时颜色层叠在模糊之上。
   */
  function background(b = {}, t, ctx = {}) {
    const glass = !!b.Glass, blur = Math.max(0, (+b.Blur || 0) * (ctx.blurScale ?? 1));
    let base;
    if (ctx.surface) base = glass ? 'transparent' : surfaceTint(b.Color, b.ColorOpacity ?? .8, b.ColorCleared, t);
    else base = ctx.shared || (glass && !b.Color) ? 'transparent' : !b.Color ? t.surface : css(rgba(b.Color, t.surface));
    const path = b.PlaylistEnabled && b.Playlist?.length ? b.Playlist[0] : b.ImagePath;
    const filter = `backdrop-filter:blur(${blur}px);-webkit-backdrop-filter:blur(${blur}px)`;
    const overlay = !glass ? ''
      : ctx.surface ? `<div class="pk-fill" style="${filter};background:${surfaceTint(b.Color, b.ColorOpacity ?? .8, b.ColorCleared, t)}"></div>`
        : `<div class="pk-fill" style="${filter};background:${t.light ? 'rgba(255,255,255,.141)' : 'rgba(0,0,0,.141)'}"></div>`;
    return `<div class="pk-fill pk-bg" style="background:${base}">${ctx.shared ? '' : media(path, b.ImageMode, ctx)}${overlay}</div>`;
  }

  // ---------- 磁贴（Controls/SubjectTileControl.cs）
  const DEFAULT_WHITE = ['#F7F7F9', '#FFFFFF'];
  function runStyle(r, doc, t) {
    const s = [];
    if (r.bold != null && r.bold !== !!doc.TileBodyBold) s.push(`font-weight:${r.bold ? 700 : 400}`);
    if (r.italic != null && r.italic !== !!doc.TileBodyItalic) s.push(`font-style:${r.italic ? 'italic' : 'normal'}`);
    if (r.underline) s.push('text-decoration:underline');
    if (r.fontFamily) s.push(`font-family:${fontStack(r.fontFamily)}`);
    // RichEdit 的字号以磅保存，显示为 DIP 需乘 4/3。
    if (r.fontSize) s.push(`font-size:${(r.fontSize * 4 / 3).toFixed(2)}px`);
    if (r.color) {
      let c = palette(r.color, t.macaron);
      if (t.light && DEFAULT_WHITE.includes(String(c).toUpperCase())) c = t.text;
      s.push(`color:${c}`);
    }
    if (r.highlight) s.push(`background:${palette(r.highlight, t.macaron)}`);
    return s.join(';');
  }
  const fontStack = f => `${JSON.stringify(String(f)).replace(/"/g, "'")},'HarmonyOS Sans SC',sans-serif`;
  const richHtml = (runs, doc, t) => rtNormalize(runs).map(r => `<span style="${esc(runStyle(r, doc, t))}">${esc(r.text).replace(/\n/g, '<br>')}</span>`).join('');

  /**
   * subject = { name, accent, explicit, w, h, entries: [{ runs, images: [src] }] }；ctx.cls 为额外的 class（选中、锁定）。
   * 结构与真实磁贴相同：3px 主题色边框、3px 圆角、面板背景、左上 14/10 内边距、右下 72 号 16% 水印、
   * 半粗体主题色标题、“1.” 序号 + 正文默认字体字号的富文本。
   */
  function tile(subject, doc, t, ctx = {}) {
    const acc = accent(subject.accent || '#818CF8', subject.explicit, t.macaron);
    const body = [`font-family:${fontStack(doc.TileBodyFontFamily || 'HarmonyOS Sans SC')}`, `font-size:${Math.min(72, Math.max(12, +doc.TileBodyFontSize || 20))}px`,
      `font-weight:${doc.TileBodyBold ? 700 : 400}`, `font-style:${doc.TileBodyItalic ? 'italic' : 'normal'}`].join(';');
    const rows = subject.entries.map((e, i) => `<div class="pk-row"><span class="pk-num">${i + 1}.</span><div class="pk-body" style="${body}">${richHtml(e.runs, doc, t)}</div></div>
      ${e.images?.length ? `<div class="pk-images">${e.images.map(src => `<img src="${esc(src)}" alt="" draggable="false">`).join('')}</div>` : ''}`).join('');
    const pos = ctx.x != null ? `left:${ctx.x}px;top:${ctx.y}px;` : '';
    return `<div class="pk-tile ${esc(ctx.cls || '')}" ${ctx.attrs || ''} style="${pos}width:${subject.w}px;height:${subject.h}px;--acc:${esc(acc)}">
      ${background(doc.TileBackground, t, { ...ctx, surface: true, cover: false })}
      <div class="pk-tile-content">
        <div class="pk-wm">${esc(subject.name)}</div>
        <div class="pk-title" style="font-size:${+doc.TileTitleSize || 29}px;max-width:${Math.max(240, subject.w - 150)}px">${esc(subject.name)}</div>
        <div class="pk-entries">${rows}</div>
      </div>
      ${ctx.grip ? '<div class="pk-grip" data-grip></div>' : ''}
    </div>`;
  }

  /** 设置页磁贴示例（MainWindow.SettingsPreviews.cs CreateTileAppearanceSample）。 */
  function sampleTile() {
    const run = text => ({ text, bold: true, italic: false, underline: false, fontFamily: null, fontSize: 18, color: '#F7F7F9', highlight: null });
    return {
      name: '这是标题~', accent: '#FBBF24', explicit: false, w: 560, h: 320,
      entries: [
        { runs: [run('当有一天你不再纠结于答案 当我们又重逢于天涯或沧海')] },
        { runs: [run('Through hardships to the stars.')] },
        { runs: [run('Per ardua ad '), { ...run('astra'), highlight: '#F472B6' }, run('.')] }
      ]
    };
  }

  // ---------- 时钟与组件（MainWindow.xaml ClockContentView / ClockComponents）
  const WEIGHT = { Light: 300, Normal: 400, Medium: 500, Bold: 700 };
  function clockColor(doc, t) {
    const c = rgba(doc.ClockColor);
    // 纯黑和纯白视为“跟随主题”。
    if (!c || (c[0] === c[1] && c[1] === c[2] && (c[0] === 0 || c[0] === 255))) return t.text;
    return css(c);
  }
  function clock(doc, t, now = new Date()) {
    const pad = n => String(n).padStart(2, '0');
    const family = fontStack(doc.ClockFontFamily || 'HarmonyOS Sans SC'), color = clockColor(doc, t);
    return `<div class="pk-clock" style="color:${color};font-family:${family}">
      <div class="pk-time"><span class="pk-time-main" style="font-weight:${WEIGHT[doc.ClockFontWeight] || 400}">${pad(now.getHours())}:${pad(now.getMinutes())}</span><span class="pk-time-sec">${pad(now.getSeconds())}</span></div>
      <div class="pk-date">${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 星期${WEEK[now.getDay()]}</div>
    </div>`;
  }
  const widgetStyle = (doc, t) => surfaceStyle(doc.WidgetBackgroundColor, doc.WidgetBackgroundOpacity ?? 1, doc.WidgetBackgroundColorCleared, doc.WidgetGlass, doc.WidgetBlur ?? 20, t);
  function weatherCard(doc, t, text = '24° 多云') {
    return `<div class="pk-card" style="${widgetStyle(doc, t)}"><i class="pk-icon" style="color:${t.warn}">${GLYPH.Weather}</i><span>${esc(text)}</span></div>`;
  }
  function noiseCard(doc, t) {
    return `<div class="pk-card pk-card-noise" style="${widgetStyle(doc, t)}"><i class="pk-icon" style="color:${t.ok}">${GLYPH.Microphone}</i><span class="pk-noise-num">42</span><span>dB · 安静</span></div>`;
  }
  const components = (doc, t) => `<div class="pk-components">${weatherCard(doc, t)}${noiseCard(doc, t)}</div>`;

  // ---------- 控制窗（MainWindow.SettingsPreviews.cs PreviewToolbar）
  function toolbarSize(doc) {
    const pos = doc.ToolbarPosition || 'BottomCenter', vertical = pos.startsWith('Center'), iconOnly = doc.ToolbarIconOnly !== false;
    const scale = Math.min(2, Math.max(.6, +doc.ToolbarScale || 1)), border = Math.min(20, Math.max(0, +(doc.ToolbarBorderThickness ?? 1)));
    const w = ((vertical ? (iconOnly ? 44 : 64) : (iconOnly ? 44 : 88) * 3 + 8) + 14) * scale + border * 2;
    const h = (((iconOnly ? 44 : 64) * (vertical ? 3 : 1)) + (vertical ? 8 : 0) + 14) * scale + border * 2;
    return { pos, vertical, iconOnly, scale, border, w, h };
  }
  function toolbarRect(doc, W, H) {
    const s = toolbarSize(doc), ix = +(doc.ToolbarHorizontalInset ?? 24), iy = +(doc.ToolbarVerticalInset ?? 24);
    const x = s.pos.endsWith('Left') ? ix : s.pos.endsWith('Right') ? W - ix - s.w : (W - s.w) / 2;
    const y = s.pos.startsWith('Top') ? iy : s.vertical ? (H - s.h) / 2 : H - iy - s.h;
    return { ...s, x, y };
  }
  function toolbar(doc, t, W, H) {
    const r = toolbarRect(doc, W, H), radius = Math.max(0, +(doc.ToolbarRadius ?? 14));
    const bw = (r.iconOnly ? 44 : r.vertical ? 64 : 88) * r.scale, bh = (r.iconOnly ? 44 : 64) * r.scale, padding = 7 * r.scale;
    const btnRadius = Math.min(Math.max(0, radius - padding), Math.min(bw, bh) / 2);
    const labelFirst = !r.vertical && r.pos.startsWith('Top');
    const buttons = [['Edit', '编辑看板'], ['Settings', '设置'], ['FullScreen', '进入全屏']].map(([g, label]) => {
      const icon = `<i class="pk-icon" style="font-size:${18 * r.scale}px">${GLYPH[g]}</i>`;
      const text = r.iconOnly ? '' : `<span style="font-size:${(r.vertical ? 8 : 10) * r.scale}px">${label}</span>`;
      return `<div class="pk-tb-btn" style="width:${bw}px;height:${bh}px;padding:${6 * r.scale}px;border-radius:${btnRadius}px;gap:${(r.vertical ? 2 : 4) * r.scale}px">${labelFirst ? text + icon : icon + text}</div>`;
    }).join('');
    const border = doc.ToolbarBorderColor ? css(rgba(doc.ToolbarBorderColor, t.line)) : t.line;
    return `<div class="pk-toolbar" style="left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;padding:${padding}px;gap:${4 * r.scale}px;flex-direction:${r.vertical ? 'column' : 'row'};
      border:${r.border}px solid ${border};border-radius:${radius}px;color:${t.text};${surfaceStyle(doc.ToolbarBackgroundColor, doc.ToolbarBackgroundOpacity ?? .8, doc.ToolbarBackgroundColorCleared, doc.ToolbarGlass, doc.ToolbarBlur ?? 20, t)}">${buttons}</div>`;
  }

  // ---------- 网格（MainWindow.xaml.cs DrawGrid）
  function grid(doc, style, w, h, ox = 0, oy = 0) {
    if (style === 'None') return '';
    const g = Math.min(160, Math.max(16, +doc.GridSize || 48)), id = 'pkg' + Math.random().toString(36).slice(2, 8);
    // 图案把线/点画在格子中央并整体平移半格，线条不会在图案边缘被裁成一半。
    const x = ox - g / 2, y = oy - g / 2;
    const cell = style === 'Dots'
      ? `<circle cx="${g / 2}" cy="${g / 2}" r="${Math.min(12, Math.max(1, +doc.GridDotDiameter || 3)) / 2}" fill="${css(rgba(doc.GridDotColor, '#8F56565C'))}"/>`
      : `<path d="M${g / 2} 0V${g}M0 ${g / 2}H${g}" stroke="${css(rgba(doc.GridColor, '#6956565C'))}" stroke-width="${Math.min(5, Math.max(.5, +doc.GridLineThickness || 1.6))}" fill="none"/>`;
    return `<svg class="pk-fill pk-grid" width="${w}" height="${h}"><defs><pattern id="${id}" x="${x}" y="${y}" width="${g}" height="${g}" patternUnits="userSpaceOnUse">${cell}</pattern></defs><rect width="100%" height="100%" fill="url(#${id})"/></svg>`;
  }
  const effectiveGrid = (doc, editing) => editing && doc.ShowGridWhileEditing !== false ? 'Grid' : ['Grid', 'Dots', 'None'].includes(doc.GridStyle) ? doc.GridStyle : 'Grid';

  // ---------- 整屏场景（MainWindow.Layout.cs）
  const SPLIT = d => Math.min(.9, Math.max(.1, +d.SplitRatio || .4));
  const sharedOn = d => (d.LayoutMode || 'Split') === 'Split' && !!d.SharedBackgroundEnabled;

  /**
   * 整屏：W×H 的大屏，按布局模式分出时钟区与作业板，磁贴按大屏坐标摆放，控制窗按位置和边距停靠。
   * opts = { tiles, editing, interactive, assetUrl }；tiles 的坐标单位与大屏作业板一致。
   */
  function screen(doc, t, W, H, opts = {}) {
    const mode = doc.LayoutMode || 'Split', ratio = SPLIT(doc), shared = sharedOn(doc), ctx = { assetUrl: opts.assetUrl };
    const clockW = mode === 'Split' ? Math.round(W * ratio) : mode === 'Clock' ? W : 0;
    const boardX = mode === 'Split' ? clockW : 0, boardW = mode === 'Clock' ? 0 : W - boardX;
    const tiles = opts.tiles || [];
    const tileHtml = tiles.map((s, i) => tile(s, doc, t, { ...ctx, x: s.x, y: s.y, grip: opts.interactive && !s.locked, cls: s.cls, attrs: `data-tile="${i}"` })).join('');
    const region = (x, w, inner, bg) => `<div class="pk-region" style="left:${x}px;width:${w}px">${bg}${inner}</div>`;
    let body = '';
    if (mode === 'Free') {
      // 自由布局：整屏是作业板，时钟、天气与噪音组件按整屏坐标摆放。
      const wd = doc.Widgets || {};
      const free = [['Clock', clock(doc, t)], ['Weather', weatherCard(doc, t)], ['Noise', noiseCard(doc, t)]]
        .filter(([k]) => wd[k]).map(([k, h]) => `<div class="pk-fit pk-free" data-widget="${k}" style="left:${wd[k].X}px;top:${wd[k].Y}px;width:${Math.max(20, wd[k].Width)}px;height:${Math.max(20, wd[k].Height)}px"><div class="pk-fit-inner">${h}</div></div>`).join('');
      body = region(0, W, `${grid(doc, effectiveGrid(doc, opts.editing), W, H)}<div class="pk-layer">${tileHtml}</div>${free}`, `<div class="pk-fill" style="background:${t.surface}"></div>`);
    } else {
      if (clockW) body += region(0, clockW, `<div class="pk-dock" data-dock="${mode === 'Split' ? 'Split' : 'ClockMode'}"><div class="pk-fit" data-part="Clock"><div class="pk-fit-inner">${clock(doc, t)}</div></div><div class="pk-fit" data-part="Components"><div class="pk-fit-inner">${components(doc, t)}</div></div></div>`,
        background(doc.ClockBackground, t, { ...ctx, shared }));
      if (mode !== 'Clock') body += region(boardX, boardW, `${grid(doc, effectiveGrid(doc, opts.editing), boardW, H)}<div class="pk-layer">${tileHtml || (opts.placeholder ?? '')}</div>`,
        background(doc.BoardBackground, t, { ...ctx, shared }));
      if (mode === 'Split') body += `<div class="pk-divider" style="left:${clockW - .5}px;background:${t.line}"></div>${opts.interactive ? `<div class="pk-split" data-split style="left:${clockW - 14}px"></div>` : ''}`;
    }
    return `<div class="pk-scene" style="width:${W}px;height:${H}px;${vars(t)}">
      ${shared && mode === 'Split' ? background(doc.SharedBackground, t, ctx) : `<div class="pk-fill" style="background:${t.surface}"></div>`}
      ${body}${toolbar(doc, t, W, H)}</div>`;
  }
  const vars = t => `--pk-text:${t.text};--pk-surface:${t.surface};--pk-line:${t.line};color:${t.text}`;

  /** 示例底图（与大屏设置页同一张），浅色模式压 55% 白色提亮。 */
  const sampleBackdrop = t => `<img class="pk-fill pk-media" src="board-assets/tile-preview-background.png" alt="" draggable="false" style="object-fit:cover"><div class="pk-fill" style="background:#fff;opacity:${t.light ? .55 : 0}"></div>`;

  /** 页内小预览，固定 640×300 设计尺寸（与大屏设置页的 PreviewSceneWidth/Height 一致）。 */
  function sample(kind, doc, t, opts = {}) {
    const W = 640, H = 300, frame = inner => `<div class="pk-scene" style="width:${W}px;height:${H}px;${vars(t)};background:${t.surface}">${inner}</div>`;
    switch (kind) {
      case 'Tile': {
        const s = sampleTile();
        return frame(`${sampleBackdrop(t)}<div class="pk-fit" style="left:30px;top:30px;width:${W - 60}px;height:${H - 60}px"><div class="pk-fit-inner">${tile(s, doc, t, { assetUrl: opts.assetUrl })}</div></div>`);
      }
      case 'Components':
        return frame(`${sampleBackdrop(t)}<div class="pk-center">${components(doc, t)}</div>`);
      case 'Clock':
        return frame(`${sampleBackdrop(t)}<div class="pk-center">${clock(doc, t)}</div>`);
      case 'Grid':
        return frame([false, true].map((edit, i) => `<div class="pk-half" style="left:${i * 320}px">${grid(doc, effectiveGrid(doc, edit), 320, 300)}
          <div class="pk-chip" style="background:${t.surface}">${edit ? '编辑模式' : '查看模式'}</div></div>`).join(''));
      case 'Toolbar': {
        // 在整屏坐标里截取控制窗附近，保持 640:300 的比例。
        const SW = 1600, SH = 900, r = toolbarRect(doc, SW, SH);
        const ch = Math.max(300, r.h + 64, (r.w + 64) * 300 / 640), cw = ch * 640 / 300;
        const cx = Math.min(Math.max(r.x + r.w / 2 - cw / 2, 0), Math.max(0, SW - cw)), cy = Math.min(Math.max(r.y + r.h / 2 - ch / 2, 0), Math.max(0, SH - ch));
        const bg = background(sharedOn(doc) ? doc.SharedBackground : doc.BoardBackground, t, { assetUrl: opts.assetUrl, cover: true });
        return `<div class="pk-scene" style="width:${cw}px;height:${ch}px;${vars(t)}"><div class="pk-crop" style="width:${SW}px;height:${SH}px;left:${-cx}px;top:${-cy}px">${bg}${toolbar(doc, t, SW, SH)}</div></div>`;
      }
      default: return '';
    }
  }

  // ---------- 排版：等比缩放盒（Viewbox）与停靠的时钟、组件栏
  /** 把 .pk-fit 的内容等比缩放、居中放进盒子，与 XAML 的 Viewbox(Stretch=Uniform) 相同。 */
  function fit(root) {
    for (const box of root.querySelectorAll('.pk-fit')) {
      const inner = box.firstElementChild; if (!inner) continue;
      inner.style.transform = '';
      const w = inner.offsetWidth, h = inner.offsetHeight, bw = box.clientWidth, bh = box.clientHeight;
      if (!w || !h || !bw || !bh) continue;
      const s = Math.min(bw / w, bh / h);
      inner.style.transform = `translate(${(bw - w * s) / 2}px,${(bh - h * s) / 2}px) scale(${s})`;
    }
  }

  /**
   * 停靠的时钟与组件栏：没有手动调整过时按大屏的默认公式居中摆放，调整过的沿用保存的位置
   * （宽度按时钟内容的实际宽高比收紧并回到中轴线）。
   */
  function dock(root, doc) {
    for (const d of root.querySelectorAll('.pk-dock')) {
      const prefix = d.dataset.dock, split = prefix === 'Split', W = d.clientWidth, H = d.clientHeight;
      const clockBox = d.querySelector('[data-part=Clock]'), compBox = d.querySelector('[data-part=Components]');
      const ci = clockBox.firstElementChild;
      const aspect = ci.offsetWidth > 1 && ci.offsetHeight > 1 ? Math.min(4, Math.max(1, ci.offsetWidth / ci.offsetHeight)) : 2.4;
      const saved = doc.Widgets || {}, custom = doc.CustomizedDockedWidgets || [];
      const place = (key, def, ratio, min) => {
        const r = custom.includes(key) && saved[key] ? { ...saved[key] } : def();
        const max = Math.max(40, Math.min(W, Math.max(0, H - r.Y) * ratio));
        r.Width = Math.min(Math.max(r.Width, Math.min(min, max)), max); r.Height = r.Width / ratio;
        r.Y = Math.min(Math.max(0, r.Y), Math.max(0, H - r.Height)); r.X = (W - r.Width) / 2;
        return r;
      };
      const cw0 = Math.min(split ? 720 : 760, W * (split ? .84 : .68)), pw0 = Math.min(split ? 520 : 560, W * .72);
      const c = place(prefix + 'Clock', () => {
        const ch = cw0 / aspect, group = ch + pw0 / 6.5 + 18;
        return { X: 0, Y: Math.max(0, (H - group) / 2 - (split ? H * .08 : 0)), Width: cw0, Height: ch };
      }, aspect, 220);
      const p = place(prefix + 'Components', () => ({ X: 0, Y: Math.min(Math.max(0, H - pw0 / 6.5), c.Y + c.Height + 18), Width: pw0, Height: pw0 / 6.5 }), 6.5, 240);
      for (const [box, r] of [[clockBox, c], [compBox, p]]) Object.assign(box.style, { left: r.X + 'px', top: r.Y + 'px', width: r.Width + 'px', height: r.Height + 'px' });
    }
  }

  /** 把场景放进宿主并按宿主宽度缩放；保留同一视频元素，拖动滑块时视频不会从头播放。 */
  function mount(host, sceneHtml, doc) {
    const keep = new Map([...host.querySelectorAll('video[data-keep]')].map(v => [v.dataset.keep, v]));
    host.innerHTML = `<div class="pk-viewport">${sceneHtml}</div>`;
    for (const v of host.querySelectorAll('video[data-keep]')) { const old = keep.get(v.dataset.keep); if (old) { v.replaceWith(old); keep.delete(v.dataset.keep); } }
    const viewport = host.firstElementChild, scene = viewport.firstElementChild;
    const resize = () => {
      const w = scene.offsetWidth, h = scene.offsetHeight, s = host.clientWidth / w;
      scene.style.transform = `scale(${s})`;
      viewport.style.height = h * s + 'px';
      host._pkScale = s;
    };
    resize();
    dock(scene, doc); fit(scene);
    if (!host._pkObserver) {
      host._pkObserver = new ResizeObserver(() => host._pkResize?.());
      host._pkObserver.observe(host);
    }
    host._pkResize = resize;
    return scene;
  }

  // 字体加载完成后宽度会变，停靠与等比缩放需要重新计算。
  const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();

  return { theme, palette, accent, tile, sampleTile, clock, components, toolbar, toolbarRect, grid, screen, sample, background, mount, fit, dock, fontsReady, SPLIT };
})();
