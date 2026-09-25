/**
 * 覆盖式查看面板（§17.1）
 *
 * 设计依据：任务详情、研讨详情、运行详情、成果预览是"覆盖式查看面板"，
 * 不是独立页面。点开它们时必须保住当前房间、回复串与阅读位置，
 * 关闭后原样回到原处（§17.4：「关闭不丢阅读位置」）。
 *
 * 实现要点：
 *  - 面板叠在房间之上，房间本身**不卸载**，因此滚动位置与草稿自然保留
 *  - 支持 Esc 关闭；点背板关闭
 *  - 有"返回"通路，不再出现"进去出不来"
 */

import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import { PANEL_LABEL, type PanelRef } from '../lib/panels';

export function DetailPanel({
  panel,
  roomName,
  onClose,
  children,
}: {
  panel: PanelRef;
  roomName?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  // Esc 关闭（§17.5 键盘可达）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 打开时把焦点移入面板，便于键盘操作
  useEffect(() => {
    ref.current?.focus();
  }, [panel.kind, panel.id]);

  return (
    <div className="detail-overlay" role="dialog" aria-modal="false" aria-label={PANEL_LABEL[panel.kind]}>
      {/* 背板：点它关闭，同时让下面的房间若隐若现，表明这是"叠在上面" */}
      <div className="detail-scrim" onClick={onClose} />

      <div className="detail-panel" ref={ref} tabIndex={-1}>
        <div className="detail-panel-head">
          <button className="btn sm" onClick={onClose} title="返回（Esc）">
            <Icon name="arrow-left" size={13} />
            返回{roomName ? ` ${roomName}` : ''}
          </button>
          <span className="detail-panel-title">{PANEL_LABEL[panel.kind]}</span>
          <div className="spacer" />
          <button className="icon-btn" onClick={onClose} title="关闭面板（Esc）" aria-label="关闭面板">
            <Icon name="x" size={15} />
          </button>
        </div>

        <div className="detail-panel-body">{children}</div>
      </div>
    </div>
  );
}
