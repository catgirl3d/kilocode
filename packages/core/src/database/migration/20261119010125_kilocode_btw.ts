// fork_change - new file
import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20261119010125_kilocode_btw",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`kilo_btw\` (
          \`id\` text PRIMARY KEY,
          \`session_id\` text NOT NULL,
          \`thread_id\` text NOT NULL,
          \`status\` text NOT NULL,
          \`question\` text NOT NULL,
          \`answer\` text DEFAULT '' NOT NULL,
          \`error\` text,
          \`provider_id\` text NOT NULL,
          \`model_id\` text NOT NULL,
          \`cost\` real DEFAULT 0 NOT NULL,
          \`tokens_input\` integer DEFAULT 0 NOT NULL,
          \`tokens_output\` integer DEFAULT 0 NOT NULL,
          \`tokens_reasoning\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_read\` integer DEFAULT 0 NOT NULL,
          \`tokens_cache_write\` integer DEFAULT 0 NOT NULL,
          \`time_created\` integer NOT NULL,
          \`time_completed\` integer,
          CONSTRAINT \`fk_kilo_btw_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
      yield* tx.run(`CREATE INDEX \`kilo_btw_session_time_idx\` ON \`kilo_btw\` (\`session_id\`,\`time_created\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
