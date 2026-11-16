/*
 * Slot machine art: presentation only.
 *
 * Every symbol is drawn here as inline SVG (no image files, so index.html
 * still opens from file://). Nothing in this file knows a pay, a weight or a
 * result: it draws whatever symbol id it is asked for. The math is all in
 * slots-core.js.
 *
 * SLOT_ART.install()  puts one hidden <svg> sprite (gradients + <symbol>s)
 *                     into the page; symbols are then drawn with <use>.
 * SLOT_ART.html(machineId, symbolId)  markup for one symbol.
 */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------ paint -- */
  const DEFS = `
  <linearGradient id="sa-gold" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff6c2"/><stop offset=".35" stop-color="#f5cf4a"/>
    <stop offset=".7" stop-color="#c8901a"/><stop offset="1" stop-color="#8a5a08"/></linearGradient>
  <linearGradient id="sa-gold-h" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#fff3b0"/><stop offset=".5" stop-color="#e3ac2a"/><stop offset="1" stop-color="#9a6508"/></linearGradient>
  <linearGradient id="sa-red7" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff7a6e"/><stop offset=".45" stop-color="#e3121b"/><stop offset="1" stop-color="#7d0008"/></linearGradient>
  <radialGradient id="sa-cherry" cx=".35" cy=".3" r=".75">
    <stop offset="0" stop-color="#ff9a9a"/><stop offset=".3" stop-color="#e31b2a"/><stop offset="1" stop-color="#6e0010"/></radialGradient>
  <linearGradient id="sa-leaf" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#9be35b"/><stop offset="1" stop-color="#2e7d1a"/></linearGradient>
  <linearGradient id="sa-bar" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#3a3a3a"/><stop offset=".5" stop-color="#111"/><stop offset="1" stop-color="#000"/></linearGradient>
  <linearGradient id="sa-chrome" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset=".45" stop-color="#c9ced6"/><stop offset=".55" stop-color="#8d95a0"/><stop offset="1" stop-color="#e9edf2"/></linearGradient>
  <linearGradient id="sa-brass" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffe9a8"/><stop offset=".5" stop-color="#c79a3b"/><stop offset="1" stop-color="#6e4b12"/></linearGradient>
  <linearGradient id="sa-wood" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#a0622d"/><stop offset="1" stop-color="#4e2a0f"/></linearGradient>
  <linearGradient id="sa-sea" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#3bc4e0"/><stop offset="1" stop-color="#0b4f7a"/></linearGradient>
  <linearGradient id="sa-sail" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#fffdf2"/><stop offset="1" stop-color="#d9cfae"/></linearGradient>
  <radialGradient id="sa-glow" cx=".5" cy=".5" r=".5">
    <stop offset="0" stop-color="#fff7c0" stop-opacity=".95"/><stop offset=".5" stop-color="#ffcc33" stop-opacity=".45"/><stop offset="1" stop-color="#ff9900" stop-opacity="0"/></radialGradient>
  <radialGradient id="sa-lantern" cx=".45" cy=".4" r=".7">
    <stop offset="0" stop-color="#ffd27a"/><stop offset=".35" stop-color="#ff4b2b"/><stop offset="1" stop-color="#8a0a0a"/></radialGradient>
  <linearGradient id="sa-koi" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="#ffb347"/><stop offset=".6" stop-color="#ff5e1a"/><stop offset="1" stop-color="#c22d00"/></linearGradient>
  <linearGradient id="sa-jade" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#b8ffd8"/><stop offset=".5" stop-color="#21b36b"/><stop offset="1" stop-color="#05502c"/></linearGradient>
  <linearGradient id="sa-redlacq" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#ff5a4a"/><stop offset="1" stop-color="#8f0b0b"/></linearGradient>
  <filter id="sa-shadow" x="-20%" y="-20%" width="140%" height="140%">
    <feDropShadow dx="0" dy="2" stdDeviation="1.6" flood-color="#000" flood-opacity=".55"/></filter>`;

  /* -------------------------------------------- card-rank lettering -- */
  // Video slots' low symbols: big ornate letters, each rank its own colour.
  function rank(label, c1, c2, stroke, font) {
    const size = label.length > 1 ? 50 : 62;
    return `<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/></linearGradient></defs>
      <text x="50" y="${label.length > 1 ? 68 : 72}" text-anchor="middle" font-family="${font}" font-weight="900" font-size="${size}"
        fill="url(#g)" stroke="${stroke}" stroke-width="3.5" paint-order="stroke" filter="url(#sa-shadow)" letter-spacing="-3">${label}</text>`;
  }
  // gradient ids inside <symbol> must be unique across the sprite: rank() uses
  // a placeholder id "g" that build() rewrites per symbol.

  const SERIF = 'Georgia, \'Times New Roman\', serif';
  const SANS = '\'Arial Black\', Impact, \'Segoe UI\', sans-serif';

  /* ------------------------------------------------- Gilded Sevens -- */
  const barPlate = (y, h) => `<rect x="12" y="${y}" width="76" height="${h}" rx="5" fill="url(#sa-bar)" stroke="url(#sa-gold)" stroke-width="3"/>
    <text x="50" y="${y + h * 0.76}" text-anchor="middle" font-family="${SANS}" font-weight="900" font-size="${h * 0.78}" fill="#fff" letter-spacing="1">BAR</text>`;
  const GILDED = {
    blank: '',
    cherry: `<g filter="url(#sa-shadow)">
      <path d="M50 14 C46 30 36 44 30 58" stroke="#3c6b1a" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="M50 14 C56 32 64 44 70 60" stroke="#3c6b1a" stroke-width="3.5" fill="none" stroke-linecap="round"/>
      <path d="M50 15 C62 4 80 8 84 18 C72 24 58 22 50 15 Z" fill="url(#sa-leaf)" stroke="#245c12" stroke-width="1.5"/>
      <circle cx="30" cy="68" r="19" fill="url(#sa-cherry)" stroke="#5a000c" stroke-width="2"/>
      <circle cx="70" cy="70" r="19" fill="url(#sa-cherry)" stroke="#5a000c" stroke-width="2"/>
      <ellipse cx="24" cy="61" rx="5" ry="3.5" fill="#fff" opacity=".7" transform="rotate(-30 24 61)"/>
      <ellipse cx="64" cy="63" rx="5" ry="3.5" fill="#fff" opacity=".7" transform="rotate(-30 64 63)"/></g>`,
    bar1: `<g filter="url(#sa-shadow)">${barPlate(34, 32)}</g>`,
    bar2: `<g filter="url(#sa-shadow)">${barPlate(20, 27)}${barPlate(53, 27)}</g>`,
    bar3: `<g filter="url(#sa-shadow)">${barPlate(10, 23)}${barPlate(38.5, 23)}${barPlate(67, 23)}</g>`,
    seven: `<text x="50" y="86" text-anchor="middle" font-family="${SANS}" font-weight="900" font-size="92"
      fill="url(#sa-red7)" stroke="url(#sa-gold)" stroke-width="5" paint-order="stroke" filter="url(#sa-shadow)">7</text>
      <path d="M30 22 L70 22" stroke="#fff" stroke-width="2" opacity=".35"/>`,
    crown: `<g filter="url(#sa-shadow)">
      <path d="M14 66 L10 28 L30 46 L50 18 L70 46 L90 28 L86 66 Z" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="2.5" stroke-linejoin="round"/>
      <rect x="13" y="64" width="74" height="12" rx="3" fill="url(#sa-gold-h)" stroke="#7a4a00" stroke-width="2"/>
      <circle cx="10" cy="27" r="5" fill="#e3121b" stroke="#7a4a00" stroke-width="1.5"/>
      <circle cx="50" cy="16" r="6" fill="#1e6fe3" stroke="#7a4a00" stroke-width="1.5"/>
      <circle cx="90" cy="27" r="5" fill="#e3121b" stroke="#7a4a00" stroke-width="1.5"/>
      <circle cx="50" cy="50" r="6" fill="#1fbf5a" stroke="#7a4a00" stroke-width="1.5"/>
      <rect x="16" y="80" width="68" height="16" rx="8" fill="#b3000c" stroke="url(#sa-gold)" stroke-width="2"/>
      <text x="50" y="93" text-anchor="middle" font-family="${SANS}" font-weight="900" font-size="12" fill="#fff">WILD 2X</text></g>`,
  };

  /* ------------------------------------------------ Sunken Galleon -- */
  const GALLEON = {
    nine:  rank('9',  '#b9fff4', '#0aa3a0', '#04373a', SERIF),
    ten:   rank('10', '#c5dcff', '#2a62e0', '#0b1f55', SERIF),
    jack:  rank('J',  '#d9ffb8', '#3aa61f', '#123d06', SERIF),
    queen: rank('Q',  '#f1d3ff', '#9a3be0', '#33104d', SERIF),
    king:  rank('K',  '#ffd0c4', '#e0402a', '#4d0f06', SERIF),
    ace:   rank('A',  '#fff4c2', '#e6a91c', '#4d3200', SERIF),
    anchor: `<g filter="url(#sa-shadow)" stroke="#3b2606" stroke-width="2" stroke-linejoin="round">
      <circle cx="50" cy="17" r="8" fill="none" stroke="url(#sa-brass)" stroke-width="5"/>
      <rect x="45" y="24" width="10" height="56" rx="3" fill="url(#sa-brass)"/>
      <rect x="28" y="32" width="44" height="8" rx="3" fill="url(#sa-brass)"/>
      <path d="M14 58 C18 84 40 90 50 90 C60 90 82 84 86 58 L94 62 L84 48 L74 60 L80 60 C76 76 62 80 50 80 C38 80 24 76 20 60 L26 60 L16 48 L6 62 Z" fill="url(#sa-brass)"/>
      <path d="M8 40 C22 52 30 30 50 40 C70 50 78 30 92 40" fill="none" stroke="#c9a46a" stroke-width="2.5" stroke-dasharray="4 3"/></g>`,
    compass: `<g filter="url(#sa-shadow)">
      <circle cx="50" cy="50" r="42" fill="url(#sa-brass)" stroke="#3b2606" stroke-width="2"/>
      <circle cx="50" cy="50" r="34" fill="#f4ead2" stroke="#8a6526" stroke-width="2"/>
      <g stroke="#8a6526" stroke-width="1.5">${[0, 45, 90, 135].map(a => `<line x1="50" y1="18" x2="50" y2="24" transform="rotate(${a} 50 50)"/><line x1="50" y1="76" x2="50" y2="82" transform="rotate(${a} 50 50)"/>`).join('')}</g>
      <path d="M50 20 L57 50 L50 80 L43 50 Z" fill="#1d2f5a"/><path d="M50 20 L57 50 L43 50 Z" fill="#d42020"/>
      <path d="M20 50 L50 44 L80 50 L50 56 Z" fill="#6b7a99"/>
      <circle cx="50" cy="50" r="5" fill="url(#sa-gold)" stroke="#3b2606" stroke-width="1.5"/>
      <text x="50" y="16" text-anchor="middle" font-family="${SERIF}" font-weight="900" font-size="11" fill="#3b2606">N</text></g>`,
    parrot: `<g filter="url(#sa-shadow)" stroke="#1b1b1b" stroke-width="1.6" stroke-linejoin="round">
      <path d="M42 54 C30 70 30 88 36 96 L44 96 C46 84 52 74 56 66 Z" fill="#1e5ee6"/>
      <path d="M48 58 C40 74 42 90 48 96 L54 96 C54 84 58 72 60 64 Z" fill="#f5c400"/>
      <ellipse cx="54" cy="52" rx="20" ry="24" fill="#e3211b"/>
      <path d="M40 46 C34 60 40 74 54 74 C46 66 44 56 46 46 Z" fill="#20a83a"/>
      <circle cx="56" cy="30" r="17" fill="#e3211b"/>
      <path d="M68 28 C84 28 86 46 74 50 C76 42 72 38 66 38 Z" fill="#f2c94c"/>
      <path d="M66 38 C72 38 74 44 72 48 C68 46 66 42 66 38 Z" fill="#2b2b2b"/>
      <circle cx="58" cy="26" r="6" fill="#fff"/><circle cx="59.5" cy="26" r="3" fill="#111" stroke="none"/>
      <circle cx="60.5" cy="25" r="1" fill="#fff" stroke="none"/></g>`,
    captain: `<g filter="url(#sa-shadow)" stroke-linejoin="round">
      <path d="M6 52 C20 20 80 20 94 52 C80 46 66 50 50 58 C34 50 20 46 6 52 Z" fill="#161616" stroke="url(#sa-gold)" stroke-width="3"/>
      <path d="M14 50 C28 28 72 28 86 50" fill="none" stroke="url(#sa-gold)" stroke-width="2"/>
      <circle cx="50" cy="40" r="9" fill="#f2f2f2" stroke="#111" stroke-width="1"/>
      <circle cx="47" cy="39" r="2" fill="#111"/><circle cx="53" cy="39" r="2" fill="#111"/>
      <path d="M42 50 L58 44 M42 44 L58 50" stroke="#f2f2f2" stroke-width="2.5"/>
      <path d="M78 30 C92 10 96 30 88 40" fill="none" stroke="#d93030" stroke-width="5" stroke-linecap="round"/>
      <path d="M30 62 C30 80 40 92 50 92 C60 92 70 80 70 62 C62 66 38 66 30 62 Z" fill="#e8b98f" stroke="#5a3010" stroke-width="2"/>
      <path d="M32 74 C36 92 64 92 68 74 C62 84 38 84 32 74 Z" fill="#5a2d0c"/>
      <rect x="35" y="66" width="12" height="7" rx="3" fill="#111"/><line x1="30" y1="66" x2="70" y2="64" stroke="#111" stroke-width="1.5"/>
      <circle cx="58" cy="69" r="2.5" fill="#111"/></g>`,
    wild: `<g filter="url(#sa-shadow)">
      <rect x="2" y="2" width="96" height="96" rx="10" fill="url(#sa-sea)" stroke="url(#sa-gold)" stroke-width="4"/>
      <path d="M50 10 L50 62 M30 18 L30 62 M70 20 L70 62" stroke="#3b2606" stroke-width="3"/>
      <path d="M50 12 C62 20 62 34 50 42 Z M50 40 C64 46 64 58 50 62 Z" fill="url(#sa-sail)" stroke="#8a7a55" stroke-width="1"/>
      <path d="M30 20 C40 26 40 36 30 42 Z M30 42 C42 48 42 58 30 62 Z" fill="url(#sa-sail)" stroke="#8a7a55" stroke-width="1"/>
      <path d="M70 22 C80 28 80 38 70 44 Z M70 44 C80 50 80 58 70 62 Z" fill="url(#sa-sail)" stroke="#8a7a55" stroke-width="1"/>
      <path d="M50 10 L62 13 L50 16 Z" fill="#d42020"/>
      <path d="M12 60 L88 60 L80 76 L20 76 Z" fill="url(#sa-wood)" stroke="#2a1404" stroke-width="2"/>
      <path d="M16 66 L84 66" stroke="url(#sa-gold)" stroke-width="2"/>
      <path d="M2 78 C14 72 22 84 34 78 C46 72 54 84 66 78 C78 72 86 84 98 78 L98 98 L2 98 Z" fill="#0a3a5c" opacity=".85"/>
      <rect x="16" y="80" width="68" height="16" rx="4" fill="#b3000c" stroke="url(#sa-gold)" stroke-width="2"/>
      <text x="50" y="93" text-anchor="middle" font-family="${SANS}" font-weight="900" font-size="13" fill="url(#sa-gold)" letter-spacing="2">WILD</text></g>`,
    chest: `<g filter="url(#sa-shadow)">
      <circle cx="50" cy="40" r="40" fill="url(#sa-glow)"/>
      <path d="M14 40 C14 20 86 20 86 40 L86 46 L14 46 Z" fill="url(#sa-wood)" stroke="#2a1404" stroke-width="2"/>
      <g fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1.5">
        <circle cx="34" cy="40" r="7"/><circle cx="48" cy="36" r="7"/><circle cx="62" cy="39" r="7"/><circle cx="42" cy="44" r="6"/><circle cx="57" cy="45" r="6"/></g>
      <path d="M8 48 L92 48 L88 88 L12 88 Z" fill="url(#sa-wood)" stroke="#2a1404" stroke-width="2"/>
      <path d="M8 48 L92 48 L91 56 L9 56 Z M24 48 L28 88 L20 88 L16 48 Z M76 48 L84 48 L80 88 L72 88 Z" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1.5"/>
      <rect x="42" y="56" width="16" height="16" rx="3" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1.5"/>
      <circle cx="50" cy="63" r="2.5" fill="#2a1404"/><path d="M50 64 L50 69" stroke="#2a1404" stroke-width="2"/>
      <path d="M22 18 l3 -8 l3 8 l8 3 l-8 3 l-3 8 l-3 -8 l-8 -3 Z M74 12 l2 -5 l2 5 l5 2 l-5 2 l-2 5 l-2 -5 l-5 -2 Z" fill="#fff8d0"/></g>`,
  };

  /* ---------------------------------------------- Lantern Festival -- */
  const LANTERN = {
    nine:  rank('9',  '#b8ffd8', '#16955a', '#033a1f', SERIF),
    ten:   rank('10', '#c2f1ff', '#1a8fc4', '#04324a', SERIF),
    jack:  rank('J',  '#ffe1b8', '#e07a10', '#4d2603', SERIF),
    queen: rank('Q',  '#ffd3e6', '#d4317a', '#4d0a2a', SERIF),
    king:  rank('K',  '#ffd0c0', '#c81e1e', '#4a0505', SERIF),
    ace:   rank('A',  '#fff7c7', '#e0b21a', '#4d3a00', SERIF),
    fan: `<g filter="url(#sa-shadow)">
      <path d="M50 82 L8 46 A50 50 0 0 1 92 46 Z" fill="url(#sa-redlacq)" stroke="url(#sa-gold)" stroke-width="3" stroke-linejoin="round"/>
      <g stroke="url(#sa-gold)" stroke-width="1.6">${[-40, -27, -14, 0, 14, 27, 40].map(a => `<line x1="50" y1="82" x2="50" y2="20" transform="rotate(${a} 50 82)"/>`).join('')}</g>
      <path d="M22 44 C34 30 66 30 78 44" fill="none" stroke="#fff3c4" stroke-width="2.5" opacity=".8"/>
      <circle cx="50" cy="40" r="7" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1"/>
      <circle cx="50" cy="82" r="5" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1.5"/>
      <path d="M50 86 C48 92 52 94 50 98" stroke="#e3211b" stroke-width="3" fill="none"/></g>`,
    lantern: `<g filter="url(#sa-shadow)">
      <circle cx="50" cy="52" r="44" fill="url(#sa-glow)" opacity=".7"/>
      <line x1="50" y1="2" x2="50" y2="14" stroke="url(#sa-gold)" stroke-width="3"/>
      <rect x="32" y="12" width="36" height="9" rx="2" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1.5"/>
      <ellipse cx="50" cy="50" rx="34" ry="30" fill="url(#sa-lantern)" stroke="#7a0a0a" stroke-width="2"/>
      <g fill="none" stroke="#ffcf6a" stroke-width="1.6" opacity=".85"><ellipse cx="50" cy="50" rx="22" ry="30"/><ellipse cx="50" cy="50" rx="9" ry="30"/></g>
      <rect x="32" y="78" width="36" height="9" rx="2" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1.5"/>
      <path d="M44 87 L42 99 M50 87 L50 99 M56 87 L58 99" stroke="#e3211b" stroke-width="3"/>
      <text x="50" y="58" text-anchor="middle" font-family="${SERIF}" font-weight="900" font-size="22" fill="#ffe08a" opacity=".9">福</text></g>`,
    koi: `<g filter="url(#sa-shadow)" stroke="#5a1a00" stroke-width="1.8" stroke-linejoin="round">
      <path d="M14 52 C24 30 58 26 74 40 L92 26 C88 42 88 58 92 74 L74 60 C58 76 24 72 14 52 Z" fill="url(#sa-koi)"/>
      <path d="M30 40 C40 34 52 36 56 46 C46 50 36 48 30 40 Z M44 60 C52 56 60 58 62 64 C54 66 48 64 44 60 Z" fill="#fff6ea" stroke="none"/>
      <path d="M40 34 C44 20 56 18 60 30" fill="#ff8c3a"/><path d="M40 66 C42 80 54 82 56 70" fill="#ff8c3a"/>
      <circle cx="24" cy="48" r="4" fill="#111" stroke="none"/><circle cx="23" cy="47" r="1.2" fill="#fff" stroke="none"/>
      <path d="M14 54 C8 58 6 64 4 66 M16 56 C12 62 12 66 10 70" stroke="#5a1a00" stroke-width="1.5" fill="none"/>
      <g fill="none" stroke="#ffd2a0" stroke-width="1" opacity=".8"><path d="M40 52 a4 4 0 0 1 8 0 M50 50 a4 4 0 0 1 8 0 M60 50 a4 4 0 0 1 8 0"/></g></g>`,
    dragon: `<g filter="url(#sa-shadow)" stroke="#063d1f" stroke-width="2" stroke-linejoin="round">
      <circle cx="50" cy="50" r="46" fill="url(#sa-redlacq)" stroke="url(#sa-gold)" stroke-width="4"/>
      <path d="M22 66 C18 44 34 24 56 24 C72 24 84 34 84 46 L72 50 L80 58 L66 58 C64 66 58 72 50 74 L48 84 L40 74 C32 74 26 72 22 66 Z" fill="url(#sa-jade)"/>
      <path d="M42 28 L32 8 L48 24 Z M56 24 L60 6 L64 26 Z" fill="url(#sa-gold)" stroke="#7a4a00" stroke-width="1.5"/>
      <path d="M72 50 L84 46 M66 58 L80 58" stroke="#063d1f"/>
      <path d="M50 74 C40 88 26 90 14 84 M66 58 C80 72 90 80 94 92" fill="none" stroke="url(#sa-gold)" stroke-width="2.5" stroke-linecap="round"/>
      <ellipse cx="58" cy="38" rx="7" ry="5" fill="#fff8b0"/><circle cx="59" cy="38" r="2.6" fill="#111" stroke="none"/>
      <g fill="none" stroke="#0a6b38" stroke-width="1.4"><path d="M30 56 a5 5 0 0 1 10 0 M36 46 a5 5 0 0 1 10 0 M40 62 a5 5 0 0 1 10 0"/></g>
      <path d="M76 44 C80 42 84 44 86 42" stroke="#fff" stroke-width="2" fill="none"/></g>`,
    wild: `<g filter="url(#sa-shadow)">
      <circle cx="50" cy="50" r="46" fill="url(#sa-gold-h)" stroke="#7a4a00" stroke-width="3"/>
      <circle cx="50" cy="50" r="38" fill="none" stroke="#fff3b0" stroke-width="2" opacity=".8"/>
      <rect x="40" y="18" width="20" height="20" rx="2" fill="#7a1010" stroke="#7a4a00" stroke-width="2"/>
      <g font-family="${SERIF}" font-weight="900" font-size="12" fill="#7a3a00" text-anchor="middle"><text x="22" y="54">財</text><text x="78" y="54">寶</text></g>
      <rect x="10" y="56" width="80" height="22" rx="6" fill="#b3000c" stroke="#fff3b0" stroke-width="2"/>
      <text x="50" y="74" text-anchor="middle" font-family="${SANS}" font-weight="900" font-size="17" fill="url(#sa-gold)" letter-spacing="2">WILD</text></g>`,
    firework: `<g filter="url(#sa-shadow)">
      <circle cx="50" cy="44" r="40" fill="url(#sa-glow)" opacity=".8"/>
      <g stroke-linecap="round" stroke-width="3.5">${Array.from({ length: 16 }, (_, i) => {
        const a = i * 22.5, col = ['#ff3b3b', '#ffd23b', '#3bd2ff', '#ff6bd6'][i % 4];
        return `<line x1="50" y1="30" x2="50" y2="${i % 2 ? 12 : 6}" stroke="${col}" transform="rotate(${a} 50 44)"/>`;
      }).join('')}</g>
      <circle cx="50" cy="44" r="7" fill="#fff8d0"/>
      <rect x="14" y="74" width="72" height="20" rx="6" fill="#4a0f7a" stroke="url(#sa-gold)" stroke-width="2"/>
      <text x="50" y="89" text-anchor="middle" font-family="${SANS}" font-weight="900" font-size="13" fill="#ffe680" letter-spacing="1">BONUS</text></g>`,
  };

  const ART = { gilded: GILDED, galleon: GALLEON, lantern: LANTERN };

  /* -------------------------------------------------------- sprite -- */
  function build() {
    let out = `<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute;width:0;height:0;overflow:hidden" aria-hidden="true"><defs>${DEFS}</defs>`;
    for (const [m, syms] of Object.entries(ART)) {
      for (const [id, body] of Object.entries(syms)) {
        const gid = `sa-${m}-${id}-g`;
        const b = body.replace(/id="g"/g, `id="${gid}"`).replace(/url\(#g\)/g, `url(#${gid})`);
        out += `<symbol id="sa-${m}-${id}" viewBox="0 0 100 100">${b}</symbol>`;
      }
    }
    return out + '</svg>';
  }

  let installed = false;
  function install(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (installed || !doc || !doc.body || typeof doc.body.insertAdjacentHTML !== 'function') return;
    doc.body.insertAdjacentHTML('afterbegin', build());
    installed = true;
  }

  function html(machine, sym) {
    if (!ART[machine] || ART[machine][sym] == null || ART[machine][sym] === '') return '';
    return `<svg class="sym" viewBox="0 0 100 100" aria-hidden="true"><use href="#sa-${machine}-${sym}"/></svg>`;
  }

  const SLOT_ART = { install, html, build, has: (m, s) => !!(ART[m] && s in ART[m]) };
  if (typeof module === 'object' && module.exports) module.exports = SLOT_ART;
  else root.SLOT_ART = SLOT_ART;
})(typeof globalThis !== 'undefined' ? globalThis : this);
