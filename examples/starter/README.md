# Your Yada agent

Set your provider, model and provider API key in `.env.starter`, then run:

```sh
npm start
```

Open http://localhost:3000. SQLite persistence and a private storage encryption key are configured for you. Keep `.env.starter` private and retain its encryption key with your backups. Password protection is optional: set `YADA_STARTER_PASSWORD` to enable it.

Add reusable `SKILL.md` folders under `skills/` and restart. Add your application's typed tools in `tools.ts`; `app.ts` wires the provider, skills, tools, storage and widget together. The starter is one shared workspace. Integrate your host's authentication and permissions before using it for multiple accounts.

See the [starter guide](https://yada.edgar.co.ke/starter.html) for provider, database, MCP and deployment settings, and the [skills guide](https://yada.edgar.co.ke/skills.html) for importing skills.
