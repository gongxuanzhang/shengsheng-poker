# shengsheng-poker — 多语言 monorepo 构建入口
#
# 统一封装 Rust / WebAssembly / 前端的常用命令,未来的 Go 后台也在此扩展。
# 用法: make <target>    (直接 `make` 或 `make help` 查看全部命令)

# ---- 目录 ----
FRONTEND_DIR   := frontend
WASM_CRATE_DIR := solver-wasm
ENGINE_DIR     := postflop-solver
WASM_OUT_DIR   := $(FRONTEND_DIR)/src/wasm/solver

# ---- 工具(可用环境变量覆盖,如 make NPM=pnpm ...) ----
NPM       ?= npm
CARGO     ?= cargo
WASM_PACK ?= wasm-pack

.DEFAULT_GOAL := help

.PHONY: help install dev build build-wasm build-frontend \
        test test-rust test-frontend clean doctor

help: ## 显示可用命令
	@echo "shengsheng-poker — 常用命令:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "提示: 仅运行前端只需 node/npm;重新编译 WASM 引擎需 cargo + wasm-pack(见 make doctor)。"

install: ## 安装前端依赖 (npm ci)
	cd $(FRONTEND_DIR) && $(NPM) ci

# node_modules 守卫: 不存在时自动安装(供 dev / test-frontend 依赖)
$(FRONTEND_DIR)/node_modules:
	cd $(FRONTEND_DIR) && $(NPM) install

dev: $(FRONTEND_DIR)/node_modules ## 启动前端开发服务器 (缺依赖时自动安装)
	cd $(FRONTEND_DIR) && $(NPM) run dev

build: build-wasm build-frontend ## 完整构建: WASM 引擎 + 前端静态产物

build-wasm: ## 将 Rust solver 编译为 WebAssembly (输出到 frontend/src/wasm/solver)
	cd $(WASM_CRATE_DIR) && $(WASM_PACK) build --target web --out-name solver --out-dir ../$(WASM_OUT_DIR)

build-frontend: ## 安装依赖并打包前端静态产物 (输出到 frontend/dist)
	cd $(FRONTEND_DIR) && $(NPM) ci && $(NPM) run build

test: test-rust test-frontend ## 运行全部测试

test-rust: ## 运行 Rust 引擎与 WASM 接口层的测试
	cd $(ENGINE_DIR) && $(CARGO) test
	cd $(WASM_CRATE_DIR) && $(CARGO) test

test-frontend: $(FRONTEND_DIR)/node_modules ## 前端质量检查 (构建校验)
	cd $(FRONTEND_DIR) && $(NPM) run check

clean: ## 清理构建产物 (Rust target、wasm pkg、前端 dist/node_modules、Vite 缓存)
	rm -rf $(ENGINE_DIR)/target
	rm -rf $(WASM_CRATE_DIR)/target
	rm -rf $(WASM_CRATE_DIR)/pkg
	rm -rf $(FRONTEND_DIR)/dist
	rm -rf $(FRONTEND_DIR)/node_modules
	# 兜底清理散落的 Vite 缓存 (node_modules/.vite 已随上面删除;这里清理其它位置)
	find . -type d -name .vite -not -path './.git/*' -prune -exec rm -rf {} +
	@echo "已清理构建产物。已提交的 WASM 产物 ($(WASM_OUT_DIR)) 保留,不受影响。"

doctor: ## 检查本机工具链 (node/npm/cargo/wasm-pack) 是否就绪并输出版本
	@echo "== 工具链检查 =="
	@printf "%-12s" "node:";      if command -v node      >/dev/null 2>&1; then node --version;      else echo "缺失 — 运行前端需要 Node.js (>=18),见 https://nodejs.org"; fi
	@printf "%-12s" "npm:";       if command -v npm       >/dev/null 2>&1; then npm --version;       else echo "缺失 — 随 Node.js 一并安装"; fi
	@printf "%-12s" "cargo:";     if command -v cargo     >/dev/null 2>&1; then $(CARGO) --version;  else echo "缺失 — 重新编译引擎需要 Rust (>=1.85),见 https://rustup.rs"; fi
	@printf "%-12s" "wasm-pack:"; if command -v wasm-pack >/dev/null 2>&1; then $(WASM_PACK) --version; else echo "缺失 — 编译 WASM 需要 wasm-pack,见 https://rustwasm.github.io/wasm-pack/installer/"; fi
	@echo ""
	@echo "说明: 仅运行/调试前端只需 node + npm;修改并重新编译引擎才需要 cargo + wasm-pack。"
