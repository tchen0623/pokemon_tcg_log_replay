@echo off
chcp 65001 >nul
REM ============================================
REM  PTCGL Replay+ 一键推送到 GitHub
REM  用法: 把下面的 YOUR_NAME 改成你的 GitHub 用户名, 双击运行
REM  前提: 已在 https://github.com/new 创建名为 ptcgl-replay 的空仓库(不要勾选 README)
REM ============================================
set USERNAME=tchen0623
set REPO=ptcgl-replay

cd /d "%~dp0"
git remote remove origin 2>nul
git remote add origin https://github.com/%USERNAME%/%REPO%.git
git branch -M main
git push -u origin main
echo.
if %errorlevel%==0 (
  echo 推送成功! 接下来开启 Pages:
  echo   1. 打开 https://github.com/%USERNAME%/%REPO%/settings/pages
  echo   2. Source 选 "Deploy from a branch", Branch 选 main / ^(root^), 点 Save
  echo   3. 等 1-2 分钟, 访问 https://%USERNAME%.github.io/%REPO%/
) else (
  echo 推送失败: 如果是第一次推送, 会弹出浏览器登录窗口, 授权后重试即可
)
pause
