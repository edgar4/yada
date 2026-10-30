# Yada

A standalone, extensible agent for websites and applications, with replaceable model providers and connectors for MCP servers, backend APIs, and databases.

Status: repository initialized; architecture and implementation plan prepared. The runtime is not implemented yet.

Start with [the implementation plan](docs/plan.md). It covers the existing Talon implementation, target boundaries, delivery milestones, and migration gates.

The first integration will replace Talon's embedded Yada through a compatibility adapter. Other applications will use the same runtime through a server SDK or hosted API and an optional web widget.
