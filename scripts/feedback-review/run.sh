#!/usr/bin/env bash
# 轻阅三天一次的反馈处理 (2026-11-19 用户要求): 拉应用内反馈 + GitHub open issue,
# 在独立 worktree 里让 Claude 修 bug、评估功能需求, 报告写到 ~/.local/state/lightread-feedback-review/<日期>/report.md。
# 不推送、不发版; 修复留在本地分支 feedback-review/<日期>, 由作者确认后合并。
# 定时: systemd 用户 timer lightread-feedback-review.timer (见同目录 *.service / *.timer)。手动跑: scripts/feedback-review/run.sh
set -euo pipefail

REPO=/home/ubuntu/workspace/LightRead
STATE=$HOME/.local/state/lightread-feedback-review
DAY=$(TZ=Asia/Shanghai date +%Y%m%d)
RUN_DIR=$STATE/$DAY
BRANCH=feedback-review/$DAY
WT=$HOME/workspace/lightread-feedback-review
export PATH=$HOME/.local/bin:$HOME/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin
export CLAUDE_CONFIG_DIR=${CLAUDE_CONFIG_DIR:-$HOME/.claude-account4}

mkdir -p "$STATE"
exec 9>"$STATE/.lock"
flock -n 9 || { echo "上一次还没跑完, 跳过"; exit 0; }
mkdir -p "$RUN_DIR/logs"
exec >>"$RUN_DIR/run.log" 2>&1
echo "== $(date -Is) 开始"

PREV=$(ls -1d "$STATE"/2* 2>/dev/null | grep -v "/$DAY\$" | tail -1 || true)
[ -n "$PREV" ] && [ -f "$PREV/report.md" ] && cp "$PREV/report.md" "$RUN_DIR/previous-report.md"

# 1. 收集 (确定性, 不经模型)
cd "$REPO"
node scripts/feedback-digest.mjs --logs "$RUN_DIR/logs" >"$RUN_DIR/app-feedback.md"
node scripts/feedback-digest.mjs --json >"$RUN_DIR/app-feedback.json"
gh issue list --repo yzfly/LightRead --state open --limit 200 \
  --json number,title,body,author,labels,createdAt,updatedAt,comments,url >"$RUN_DIR/issues.json"

# 2. 独立 worktree (不碰作者正在用的工作区)
git fetch -q origin main
if [ -d "$WT" ]; then git worktree remove --force "$WT"; fi
git worktree add -q -B "$BRANCH" "$WT" origin/main

# 3. 处理
cd "$WT"
export RUN_DIR
timeout 4h claude -p "$(cat "$REPO/scripts/feedback-review/prompt.md")

本次: RUN_DIR=$RUN_DIR, 分支 $BRANCH, worktree $WT, 日期 $DAY。" \
  --dangerously-skip-permissions --output-format text >"$RUN_DIR/claude.out" || echo "claude 退出码 $?"

# 4. 收尾: 没有新提交就删掉分支和 worktree
cd "$REPO"
if [ "$(git rev-list --count "origin/main..$BRANCH")" = 0 ]; then
  git worktree remove --force "$WT"
  git branch -q -D "$BRANCH"
  echo "没有修复提交, 已清理分支"
else
  git -C "$WT" log --oneline "origin/main..$BRANCH"
fi
[ -f "$RUN_DIR/report.md" ] || cp "$RUN_DIR/claude.out" "$RUN_DIR/report.md"
ln -sfn "$RUN_DIR" "$STATE/latest"
echo "== $(date -Is) 结束, 报告 $RUN_DIR/report.md"
