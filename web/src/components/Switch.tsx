// 职责：Switch —— 开关（原型 .switch 结构）。
export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <label className="switch" title={label}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="track" />
    </label>
  );
}
