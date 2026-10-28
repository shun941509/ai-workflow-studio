import { Maximize2, Focus, Minus, Plus } from 'lucide-react';
import styles from './canvas-toolbar.module.css';

/** Native controls remain keyboard reachable; zoom shortcuts never intercept an inspector's text input. */
export function CanvasToolbar({ zoom, selected, overview, reveal, changeZoom }: { zoom: number; selected: boolean; overview: () => void; reveal: () => void; changeZoom: (delta: number) => void }) {
  return <div className={styles.toolbar} role="group" aria-label="캔버스 보기">
    <button type="button" onClick={overview}><Maximize2 size={15}/>전체 보기</button>
    <button type="button" disabled={!selected} onClick={reveal}><Focus size={15}/>선택 블록 보기</button>
    <span className={styles.divider}/><button type="button" aria-label="캔버스 축소" disabled={zoom <= .3} onClick={() => changeZoom(-.15)}><Minus size={16}/></button>
    <output aria-label="캔버스 배율">{Math.round(zoom * 100)}%</output>
    <button type="button" aria-label="캔버스 확대" disabled={zoom >= 1.5} onClick={() => changeZoom(.15)}><Plus size={16}/></button>
  </div>;
}
