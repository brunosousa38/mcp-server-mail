.DEFAULT_GOAL := help

COMPOSE         := docker compose
BASE            := -f docker-compose.yml
WAN             := $(BASE) -f docker-compose.wan.yml
LAN             := $(BASE) -f docker-compose.lan.yml
LAN_HTTP        := $(BASE) -f docker-compose.lan-http.yml

.PHONY: help build up-wan up-lan up-lan-http down stop logs ps restart \
        shell token setup-env

help: ## Show this help
	@echo ""
	@echo "  Infomaniak MCP Mail Server — deployment targets"
	@echo ""
	@echo "  SETUP"
	@echo "    make setup-env        Copy .env.example → .env and generate MCP_AUTH_TOKEN"
	@echo ""
	@echo "  BUILD"
	@echo "    make build            Build the Docker image"
	@echo ""
	@echo "  DEPLOYMENT MODES"
	@echo "    make up-wan           Start WAN mode  (Caddy + Let's Encrypt, needs MCP_PUBLIC_DOMAIN + ACME_EMAIL)"
	@echo "    make up-lan           Start LAN mode  (Caddy + tls internal / self-signed cert)"
	@echo "    make up-lan-http      Start LAN HTTP  (direct port exposure, no TLS — simplest)"
	@echo ""
	@echo "  OPERATIONS"
	@echo "    make down             Stop and remove containers"
	@echo "    make stop             Stop containers without removing them"
	@echo "    make restart          Restart mcp-mail"
	@echo "    make logs             Follow all logs"
	@echo "    make ps               Show running containers"
	@echo "    make shell            Open a shell inside mcp-mail"
	@echo "    make token            Generate a new random MCP_AUTH_TOKEN (32 bytes hex)"
	@echo ""

# ── Setup ──────────────────────────────────────────────────────────────────────

setup-env: ## Copy .env.example to .env and auto-generate MCP_AUTH_TOKEN
	@if [ -f .env ]; then \
		echo "  .env already exists — skipping copy (delete it first to reset)"; \
	else \
		cp .env.example .env; \
		echo "  Created .env from .env.example"; \
	fi
	@if grep -q '^MCP_AUTH_TOKEN=$$' .env; then \
		TOKEN=$$(openssl rand -hex 32); \
		sed -i "s|^MCP_AUTH_TOKEN=$$|MCP_AUTH_TOKEN=$$TOKEN|" .env; \
		echo "  Generated MCP_AUTH_TOKEN (saved to .env)"; \
	else \
		echo "  MCP_AUTH_TOKEN already set — keeping existing value"; \
	fi
	@echo ""
	@echo "  ✔ .env ready — fill in MAIL_TOKEN then choose a deployment mode:"
	@echo "      WAN :  edit MCP_PUBLIC_DOMAIN and ACME_EMAIL, then: make up-wan"
	@echo "      LAN :  edit MCP_LAN_HOST (e.g. ':443' or 'mcp.local'), then: make up-lan"
	@echo "      HTTP:  edit LAN_HTTP_PORT if needed,                  then: make up-lan-http"

# ── Build ──────────────────────────────────────────────────────────────────────

build: ## Build the mcp-mail Docker image
	$(COMPOSE) $(BASE) build

# ── Start ──────────────────────────────────────────────────────────────────────

up-wan: ## WAN mode — Caddy + automatic Let's Encrypt TLS
	$(COMPOSE) $(WAN) up -d --build
	@echo ""
	@echo "  Started in WAN mode."
	@echo "  MCP endpoint: https://$$(grep MCP_PUBLIC_DOMAIN .env | cut -d= -f2)/mcp"
	@echo "  Health:       https://$$(grep MCP_PUBLIC_DOMAIN .env | cut -d= -f2)/healthz"

up-lan: ## LAN mode — Caddy + self-signed TLS (no Let's Encrypt, no domain needed)
	$(COMPOSE) $(LAN) up -d --build
	@echo ""
	@echo "  Started in LAN mode (TLS with self-signed cert)."
	@HOST=$$(grep '^MCP_LAN_HOST' .env | cut -d= -f2); HOST=$${HOST:-:443}; \
	echo "  MCP endpoint: https://<host-ip>$${HOST#*:443}/mcp  (or https://<host-ip>/mcp)"; \
	echo "  Trust the Caddy CA with: docker compose exec caddy caddy trust"

up-lan-http: ## LAN HTTP mode — direct port, no reverse proxy, no TLS
	$(COMPOSE) $(LAN_HTTP) up -d --build
	@echo ""
	@echo "  Started in LAN HTTP mode (plain HTTP, no TLS)."
	@PORT=$$(grep '^LAN_HTTP_PORT' .env | cut -d= -f2); PORT=$${PORT:-3000}; \
	echo "  MCP endpoint: http://<host-ip>:$${PORT}/mcp"

# ── Operations ─────────────────────────────────────────────────────────────────

down: ## Stop and remove all containers, networks (keeps volumes)
	$(COMPOSE) $(WAN) down 2>/dev/null || true
	$(COMPOSE) $(LAN) down 2>/dev/null || true
	$(COMPOSE) $(LAN_HTTP) down 2>/dev/null || true

stop: ## Stop containers without removing them
	$(COMPOSE) $(BASE) stop

restart: ## Restart mcp-mail container
	$(COMPOSE) $(BASE) restart mcp-mail

logs: ## Follow logs for all running containers (Ctrl-C to exit)
	$(COMPOSE) $(BASE) logs -f

ps: ## Show status of running containers
	$(COMPOSE) $(BASE) ps

shell: ## Open an interactive shell inside mcp-mail
	$(COMPOSE) $(BASE) exec mcp-mail sh

# ── Utilities ──────────────────────────────────────────────────────────────────

token: ## Generate a new random MCP_AUTH_TOKEN and print it
	@echo "New MCP_AUTH_TOKEN:"
	@openssl rand -hex 32
	@echo ""
	@echo "  Paste this value into .env as MCP_AUTH_TOKEN=<value>"
