# 🍊 QOrange Panel (Nano PaaS)

专为小内存（1G ~ 2G）VPS 打造的轻量级私有化控制面板与持续交付（CI/CD）中枢。

## 特性
- 极低资源占用（运行时内存 < 40MB）
- GitHub Webhook 本地构建与自动清理旧镜像
- 容器生命周期可视化管理（日志、重启、构建）
- 控制台自身平滑热升级

如何把这套代码推送到 GitHub 并让服务器接管？

第一步：在 Mac 本地推送到你的 GitHub

1.  在 GitHub 上点击新建一个公开仓库，比如命名为 qorange-panel。
2.  在你保存了上面这几个文件的 Mac 目录里，打开终端执行：
    git init
    git add .
    git commit -m "feat: initial commit of qorange panel"
    git branch -M main
    git remote add origin https://github.com/ynadtiy19/qorange-panel.git
    git push -u origin main

第二步：在 VPS 上彻底接管并跑通自我更新链路

回到你当前的 VPS 终端里，执行以下几行，把原本的临时目录换成正规的 Git 仓库目录：

# 1. 停用之前的旧进程并清理临时目录
systemctl stop qorange-panel
rm -rf /opt/qorange-panel

# 2. 从你刚建好的公开仓库克隆下来
git clone https://github.com/ynadtiy19/qorange-panel.git /opt/qorange-panel
cd /opt/qorange-panel

# 3. 安装依赖并启动
npm install
systemctl restart qorange-panel

之后的神仙体验：

  - 想加功能、改 UI？ 在 Mac 本地 VS Code 里随便改，改完 git push；
  - 让服务器更新？ 打开浏览器 http://103.114.160.48:8888，点击右上角的 【🚀 升级控制台本身】；
  - 面板会自动在后台拉取最新代码并静默重启，几秒钟后刷新页面，最新功能就立刻生效了！
