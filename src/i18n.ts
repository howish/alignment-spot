export type Lang = 'zh-TW' | 'ja' | 'en';

const dict = {
  'zh-TW': {
    appName: '對齊點 Alignment Spot',
    tapToPlace: '點地圖放置目標（塔、山頂…）',
    structureHeight: '目標高度（公尺）',
    sun: '太陽',
    moon: '月亮',
    noAlignment: '這天沒有可用的對齊時段',
    tooLow: '天體太低',
    noSolution: '此時刻無解（太近或超過 30 km）',
    occludedNote: '灰色虛線＝視線被地形擋住',
    approxBadge: '無高程資料・概算',
    distance: '距離',
    azimuth: '方位',
    bodyAlt: '天體高度',
    navigate: '導航到這裡',
    settings: '設定',
    alignMode: '對齊方式',
    modeBottom: '下緣貼頂（鑽石富士型）',
    modeCenter: '中心對齊',
    eyeHeight: '視線高度（公尺）',
    refraction: '大氣折射補正',
    language: '語言 / Language',
    solving: '計算中…',
    date: '日期',
    movePin: '再點地圖可移動目標',
  },
  ja: {
    appName: 'Alignment Spot',
    tapToPlace: '地図をタップしてターゲットを置く（塔・山頂…）',
    structureHeight: 'ターゲットの高さ（m）',
    sun: '太陽',
    moon: '月',
    noAlignment: 'この日は重なりが起きません',
    tooLow: '天体が低すぎ',
    noSolution: 'この時刻は解なし（近すぎ or 30 km 超）',
    occludedNote: 'グレー破線＝地形で視線が遮られる区間',
    approxBadge: '標高データなし・概算',
    distance: '距離',
    azimuth: '方位',
    bodyAlt: '天体高度',
    navigate: 'ここへナビ',
    settings: '設定',
    alignMode: '重なりの定義',
    modeBottom: '下端タッチ（ダイヤモンド富士型）',
    modeCenter: '中心一致',
    eyeHeight: '目線の高さ（m）',
    refraction: '大気差補正',
    language: '言語 / Language',
    solving: '計算中…',
    date: '日付',
    movePin: '地図をタップでターゲット移動',
  },
  en: {
    appName: 'Alignment Spot',
    tapToPlace: 'Tap the map to place the target (tower, summit…)',
    structureHeight: 'Target height (m)',
    sun: 'Sun',
    moon: 'Moon',
    noAlignment: 'No alignment possible on this date',
    tooLow: 'Body too low',
    noSolution: 'No solution at this time (too close or beyond 30 km)',
    occludedNote: 'Gray dashes = sightline blocked by terrain',
    approxBadge: 'No elevation data — approximate',
    distance: 'Distance',
    azimuth: 'Azimuth',
    bodyAlt: 'Body altitude',
    navigate: 'Navigate here',
    settings: 'Settings',
    alignMode: 'Alignment mode',
    modeBottom: 'Bottom touch (diamond-Fuji)',
    modeCenter: 'Center on tip',
    eyeHeight: 'Eye height (m)',
    refraction: 'Atmospheric refraction',
    language: 'Language',
    solving: 'Solving…',
    date: 'Date',
    movePin: 'Tap the map again to move the target',
  },
} as const;

export type StrKey = keyof (typeof dict)['en'];

let lang: Lang = (localStorage.getItem('lang') as Lang) || 'zh-TW';

export function t(key: StrKey): string {
  return dict[lang][key];
}

export function getLang(): Lang {
  return lang;
}

export function setLang(l: Lang): void {
  lang = l;
  localStorage.setItem('lang', l);
}

export const LANGS: { value: Lang; label: string }[] = [
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'ja', label: '日本語' },
  { value: 'en', label: 'English' },
];
