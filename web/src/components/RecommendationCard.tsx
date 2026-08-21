// 职责：推荐卡（Beautiful UI「Recommendation Card」移植，MIT © Shane Levine）——
//   agent 建议 + 三档置信度计量条（高置信=3 绿 / 需复核=2 黄 / 无信号=0 灰）+ 可选其他选项 + Accept/Alternatives。
//   compact 变体：单行建议（meter + 文案 + 采用/不采用），用于嵌进批复卡内。
import { useState, type ReactNode } from 'react';

export type Confidence = 'high' | 'needs-review' | 'no-signal';

export const CONF_LABEL: Record<Confidence, string> = {
  high: '高置信',
  'needs-review': '需复核',
  'no-signal': '无信号',
};

/** 计量条亮起的根数（high=3 / needs-review=2 / no-signal=0） */
const CONF_METER: Record<Confidence, number> = { high: 3, 'needs-review': 2, 'no-signal': 0 };

export interface RecOption {
  id: string;
  label: string;
  confidence?: Confidence;
}

interface Props {
  title: string;
  description?: ReactNode;
  confidence?: Confidence;
  /** 其他选项（可展开） */
  options?: RecOption[];
  /** 紧凑单行变体（无选项展开、无独立 footer） */
  compact?: boolean;
  acceptLabel?: string;
  alternativeLabel?: string;
  onAccept?: () => void;
  onAlternative?: () => void;
}

export function Meter({ confidence = 'high' }: { confidence?: Confidence }) {
  const n = CONF_METER[confidence];
  return (
    <span className="rec-meter" data-conf={confidence} aria-label={CONF_LABEL[confidence]}>
      {[0, 1, 2].map((i) => <i key={i} className={i < n ? 'on' : ''} />)}
    </span>
  );
}

export function RecommendationCard({
  title,
  description,
  confidence = 'high',
  options,
  compact = false,
  acceptLabel = '接受',
  alternativeLabel = '其他选项',
  onAccept,
  onAlternative,
}: Props) {
  const [showOptions, setShowOptions] = useState(false);

  if (compact) {
    return (
      <div className="rec" data-compact>
        <div className="rec-pad" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <Meter confidence={confidence} />
          <span className="rec-title" style={{ fontSize: 12.5 }}>{title}</span>
          {description ? <span className="rec-desc" style={{ marginTop: 0, marginLeft: 'auto', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{description}</span> : null}
          <span className="rec-actions" style={{ marginLeft: 0 }}>
            {onAlternative ? <button className="btn mini ghost" onClick={onAlternative}>{alternativeLabel}</button> : null}
            {onAccept ? <button className="btn mini primary" onClick={onAccept}>{acceptLabel}</button> : null}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="rec">
      <div className="rec-pad">
        <div className="rec-title">{title}</div>
        {description ? <div className="rec-desc">{description}</div> : null}
      </div>
      {options && options.length > 0 && showOptions ? (
        <div className="rec-options">
          <div className="rec-opt-head">其他选项</div>
          {options.map((o) => (
            <button key={o.id} type="button" className="rec-opt">
              <Meter confidence={o.confidence ?? 'no-signal'} />
              <span className="ol">{o.label}</span>
              {o.confidence ? <span className="ot">{CONF_LABEL[o.confidence]}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="rec-footer">
        <span className="rec-conf">
          <Meter confidence={confidence} />
          <b>{CONF_LABEL[confidence]}</b>
        </span>
        <span className="rec-actions">
          {options && options.length > 0 ? (
            <button className="btn" onClick={() => setShowOptions((v) => !v)}>{alternativeLabel}</button>
          ) : onAlternative ? (
            <button className="btn" onClick={onAlternative}>{alternativeLabel}</button>
          ) : null}
          {onAccept ? <button className="btn primary" onClick={onAccept}>{acceptLabel}</button> : null}
        </span>
      </div>
    </div>
  );
}
