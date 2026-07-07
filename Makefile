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
        test test-rust test-frontend test-frontend-unit ci-frontend clean doctor

# ---- 前端单测文件清单(领域 + 编排,node --test 直跑,零构建) ----
# 显式列举而非 glob:CI 的 Node 版本(见 .github/workflows/ci.yml,node 20)对 glob 支持
# 因版本而异,显式清单最稳。新增测试文件时同步补入此处。
FRONTEND_UNIT_TESTS := \
	src/domain/__tests__/positions.test.js \
	src/domain/__tests__/reducer.test.js \
	src/domain/eval/deviationEvaluator.test.js \
	src/domain/policy/preflopChartPolicy.test.js \
	src/training/__tests__/handEvaluator.test.js \
	src/training/__tests__/session.test.js \
	src/training/__tests__/settlement.test.js

help: ## 显示可用命令
	@echo "shengsheng-poker — 常用命令:"
	@echo ""
	@grep -E '^[a-zA-Z_-]+:.*## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN {FS = ":.*## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "提示: 仅运行前端只需 node/npm;重新编译 WASM 引擎需 cargo + wasm-pack(见 make doctor)。"
	@echo "工程文档: docs/ARCHITECTURE.md(架构/边界/数据流) · docs/ENGINEERING_ROADMAP.md(路线图)。"

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

test-rust: ## 校验 Rust 引擎(产品路径可编译)与 WASM 接口层
	# postflop-solver 是第三方 vendored 引擎,不由本仓库测试。
	# 其默认 features 含 bincode(2.0-rc),serialization.rs 与新版 Decode<Context>
	# API 不兼容,`cargo test` 会失败;examples/file_io.rs 又引用 bincode 门控函数,
	# 故连 `--no-default-features` 的 test 也编不过。产品只走 wasm 单线程路径,
	# 这里只验证该路径能编译(与 solver-wasm 的 default-features=false 一致,含 rayon 冒烟)。
	cd $(ENGINE_DIR) && $(CARGO) build --no-default-features --features rayon
	cd $(WASM_CRATE_DIR) && $(CARGO) test

test-frontend-unit: ## 前端领域/编排单测 (node --test,零构建、无外部依赖)
	# 领域模型 / 策略 / 评估 / 编排的纯 JS 单测。Node >=18 内置 test runner;不依赖 node_modules。
	cd $(FRONTEND_DIR) && node --test $(FRONTEND_UNIT_TESTS)

test-frontend: test-frontend-unit $(FRONTEND_DIR)/node_modules ## 前端质量检查 (单测 + 构建校验)
	cd $(FRONTEND_DIR) && $(NPM) run check

ci-frontend: ## CI 前端门禁 (干净安装依赖并构建)
	$(MAKE) build-frontend

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
