#!/bin/bash
# 生成实验项目 fixture：源码 + 数据文件（供长任务操作）
WS="$1"
mkdir -p "$WS/src" "$WS/data" "$WS/docs" "$WS/tests" "$WS/scripts"
# 源码
cat > "$WS/src/app.js" <<'JSEOF'
const express = require('express')
const app = express()
app.get('/health', (req, res) => res.json({ ok: true }))
app.get('/users', (req, res) => res.json([{ id: 1, name: 'alice' }, { id: 2, name: 'bob' }]))
app.post('/users', (req, res) => res.status(201).json({ created: true }))
app.listen(3000, () => console.log('listening on 3000'))
JSEOF
cat > "$WS/src/util.js" <<'JSEOF'
module.exports = {
  sum: (a, b) => a + b,
  clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)),
  format: (v) => `value=${v}`,
}
JSEOF
# 脚本
cat > "$WS/scripts/build.sh" <<'SHEOF'
#!/bin/bash
echo "building..."
echo "checking config"
echo "done"
SHEOF
chmod +x "$WS/scripts/build.sh"
cat > "$WS/scripts/deploy.sh" <<'SHEOF'
#!/bin/bash
echo "deploying to staging..."
echo "running checks..."
echo "deployed"
SHEOF
chmod +x "$WS/scripts/deploy.sh"
# 数据
for i in 1 2 3 4 5; do
  echo "record-$i,value-$i,category-$(expr $i % 2)" > "$WS/data/item-$i.csv"
done
cat > "$WS/data/items.json" <<'JEOF'
[
  { "id": 1, "name": "alpha", "price": 10 },
  { "id": 2, "name": "beta", "price": 20 },
  { "id": 3, "name": "gamma", "price": 30 }
]
JEOF
# 配置
cat > "$WS/package.json" <<'PEOF'
{
  "name": "fixture-app",
  "version": "1.0.0",
  "main": "src/app.js",
  "scripts": {
    "start": "node src/app.js",
    "build": "bash scripts/build.sh",
    "test": "node tests/extra.test.js"
  }
}
PEOF
echo "fixture generated at $WS"
