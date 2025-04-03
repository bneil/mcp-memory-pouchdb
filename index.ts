#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import PouchDB from 'pouchdb';
import PouchDBMemory from 'pouchdb-adapter-memory';
import { z } from "zod";

// Register memory adapter
PouchDB.plugin(PouchDBMemory);

// Define memory file path using environment variable with fallback
const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH;
const POUCHDB_PATH = process.env.POUCHDB_PATH;

// Fail early if required environment variables are not set
if (!MEMORY_FILE_PATH) {
  console.error("Error: MEMORY_FILE_PATH environment variable is required");
  process.exit(1);
}

if (!POUCHDB_PATH) {
  console.error("Error: POUCHDB_PATH environment variable is required");
  process.exit(1);
}

console.error("--------------------------------");
console.error("Starting Memory Server");
console.error("--------------------------------");
console.error("Memory File Path:", MEMORY_FILE_PATH);
console.error("PouchDB Path:", POUCHDB_PATH);
console.error("--------------------------------");

// Initialize PouchDB with configuration from environment variables
const pouchDbOptions = {
  auto_compaction: true,
  revs_limit: 10,
  deterministic_revs: true,
  leveldown: {
    writeBufferSize: 32 * 1024 * 1024, // 32MB
    maxOpenFiles: 1000,
    blockSize: 64 * 1024, // 64KB
    lockfileTimeout: 30000, // 30 seconds
  },
  ...(process.env.POUCHDB_OPTIONS ? JSON.parse(process.env.POUCHDB_OPTIONS) : {})
};

let db: PouchDB.Database;

// Helper function to check and remove stale lock file
async function checkAndRemoveLockFile() {
  if (!POUCHDB_PATH) {
    throw new Error("POUCHDB_PATH is undefined");
  }
  
  const lockPath = path.join(POUCHDB_PATH, 'LOCK');
  try {
    const stats = await fs.stat(lockPath);
    // If lock file is older than 30 seconds, it's probably stale
    if (Date.now() - stats.mtimeMs > 30000) {
      console.error("Removing stale lock file");
      await fs.unlink(lockPath);
    }
  } catch (e) {
    // Lock file doesn't exist or can't be accessed, which is fine
  }
}

// Add initialization function with retry logic
async function initializeDatabase(retries = 5, delay = 1000): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      if (db) {
        try {
          // Add delay before closing to allow any pending operations to complete
          await new Promise(resolve => setTimeout(resolve, 1000));
          await db.close();
        } catch (e) {
          console.error("Error closing existing database connection:", e);
        }
      }
      
      // Ensure the directory exists
      try {
        if (!POUCHDB_PATH) {
          throw new Error("POUCHDB_PATH is undefined");
        }
        await fs.mkdir(POUCHDB_PATH, { recursive: true });
      } catch (e) {
        console.error("Error creating database directory:", e);
        throw e;
      }

      // Check for and remove stale lock file
      await checkAndRemoveLockFile();
      
      console.error("Initializing PouchDB with path:", POUCHDB_PATH, "and options:", pouchDbOptions);
      db = new PouchDB(POUCHDB_PATH, pouchDbOptions);
      
      // Test the connection
      await db.info();
      console.error("Database initialized successfully");
      return;
    } catch (error) {
      console.error(`Database initialization attempt ${i + 1} failed:`, error);
      if (i < retries - 1) {
        const nextDelay = delay * 2; // Exponential backoff
        console.error(`Retrying in ${nextDelay}ms...`);
        await new Promise(resolve => setTimeout(resolve, nextDelay));
        delay = nextDelay;
      } else {
        throw error;
      }
    }
  }
}

// Improve cleanup function
async function cleanup() {
  try {
    console.error("Cleaning up PouchDB...");
    if (db) {
      try {
        // Force sync before closing
        await db.compact();
      } catch (e) {
        console.error("Error during compaction:", e);
      }
      
      try {
        await db.close();
        console.error("PouchDB cleanup complete");
      } catch (e) {
        console.error("Error closing database:", e);
        throw e;
      }
    }
  } catch (error) {
    console.error("Error during cleanup:", error);
    throw error;
  }
}

process.on('exit', () => {
  cleanup().catch(console.error);
});

process.on('SIGINT', () => {
  cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
});

process.on('SIGTERM', () => {
  cleanup().then(() => process.exit(0)).catch(() => process.exit(1));
});

// We are storing our memory using entities, relations, and observations in a graph structure
interface Entity {
  _id: string;
  name: string;
  entityType: string;
  observations: string[];
  type: 'entity';
}

interface Relation {
  _id: string;
  from: string;
  to: string;
  relationType: string;
  type: 'relation';
}

interface KnowledgeGraph {
  entities: Entity[];
  relations: Relation[];
}

// The KnowledgeGraphManager class contains all operations to interact with the knowledge graph
class KnowledgeGraphManager {
  private memoryFilePath: string;

  constructor(memoryFilePath: string) {
    if (!memoryFilePath) {
      throw new Error("Memory file path is required");
    }
    this.memoryFilePath = memoryFilePath;
  }

  async getCurrentTime() {
    return new Date().toISOString();
  }

  // Add retry utility
  private async wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async retryOperation<T>(operation: () => Promise<T>, maxRetries = 5, initialDelay = 1000): Promise<T> {
    let lastError;
    let delay = initialDelay;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error: any) {
        lastError = error;
        if (error.message?.includes('Resource temporarily unavailable')) {
          console.error(`Attempt ${i + 1} failed, retrying in ${delay}ms...`);
          await this.wait(delay);
          // Exponential backoff with jitter
          delay = Math.min(delay * 2, 10000) * (0.75 + Math.random() * 0.5);
          continue;
        }
        throw error;
      }
    }
    throw lastError;
  }

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const result = await this.retryOperation(() => db.allDocs({ include_docs: true }));
      const graph: KnowledgeGraph = { entities: [], relations: [] };

      result.rows.forEach(row => {
        const doc = row.doc as unknown as Entity | Relation;
        if (doc && doc.type === 'entity') {
          graph.entities.push(doc as Entity);
        } else if (doc && doc.type === 'relation') {
          graph.relations.push(doc as Relation);
        }
      });

      return graph;
    } catch (error) {
      console.error('Error loading graph:', error);
      return { entities: [], relations: [] };
    }
  }

  private async saveGraph(graph: KnowledgeGraph): Promise<void> {
    try {
      // Save to PouchDB with retry
      const docs = [
        ...graph.entities,
        ...graph.relations
      ];
      await this.retryOperation(() => db.bulkDocs(docs));

      // Backup to file
      const lines = [
        ...graph.entities.map((e) => JSON.stringify({ ...e })),
        ...graph.relations.map((r) => JSON.stringify({ ...r })),
      ];
      await fs.writeFile(this.memoryFilePath, lines.join("\n"));
    } catch (error) {
      console.error('Error saving graph:', error);
      throw error;
    }
  }

  async createEntities(
    entities: Omit<Entity, '_id'>[]
  ): Promise<Entity[]> {
    const graph = await this.loadGraph();

    const newEntities = entities
      .filter(e => !graph.entities.some(existing => existing.name === e.name))
      .map(e => ({
        ...e,
        _id: `entity_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'entity' as const
      }));

    graph.entities.push(...newEntities);
    await this.saveGraph(graph);
    return newEntities;
  }

  async createRelations(
    relations: Omit<Relation, '_id'>[]
  ): Promise<Relation[]> {
    const graph = await this.loadGraph();

    const newRelations = relations
      .filter(r => !graph.relations.some(
        existing =>
          existing.from === r.from &&
          existing.to === r.to &&
          existing.relationType === r.relationType
      ))
      .map(r => ({
        ...r,
        _id: `relation_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: 'relation' as const
      }));

    graph.relations.push(...newRelations);
    await this.saveGraph(graph);
    return newRelations;
  }

  async addObservations(
    observations: { entityName: string; contents: string[] }[]
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    const graph = await this.loadGraph();

    const results = observations.map((o) => {
      const entity = graph.entities.find((e) => e.name === o.entityName);
      if (!entity) {
        throw new Error(`Entity with name ${o.entityName} not found`);
      }
      const newObservations = o.contents.filter(
        (content) => !entity.observations.includes(content)
      );
      entity.observations.push(...newObservations);
      return { entityName: o.entityName, addedObservations: newObservations };
    });

    await this.saveGraph(graph);
    return results;
  }

  async deleteEntities(entityNames: string[]): Promise<void> {
    const graph = await this.loadGraph();

    // Delete entities
    const entitiesToDelete = graph.entities.filter(e => entityNames.includes(e.name));
    await db.bulkDocs(entitiesToDelete.map(e => ({ ...e, _deleted: true })));

    // Delete associated relations
    const relationsToDelete = graph.relations.filter(
      r => entityNames.includes(r.from) || entityNames.includes(r.to)
    );
    await db.bulkDocs(relationsToDelete.map(r => ({ ...r, _deleted: true })));

    // Update graph in memory
    graph.entities = graph.entities.filter(e => !entityNames.includes(e.name));
    graph.relations = graph.relations.filter(
      r => !entityNames.includes(r.from) && !entityNames.includes(r.to)
    );

    await this.saveGraph(graph);
  }

  async deleteObservations(
    deletions: { entityName: string; observations: string[] }[]
  ): Promise<void> {
    const graph = await this.loadGraph();

    deletions.forEach((d) => {
      const entity = graph.entities.find((e) => e.name === d.entityName);
      if (entity) {
        entity.observations = entity.observations.filter(
          (o) => !d.observations.includes(o)
        );
      }
    });

    await this.saveGraph(graph);
  }

  async deleteRelations(
    relations: Relation[]
  ): Promise<void> {
    const graph = await this.loadGraph();

    const relationsToDelete = graph.relations.filter(
      (r) =>
        relations.some(
          (delRelation) =>
            r.from === delRelation.from &&
            r.to === delRelation.to &&
            r.relationType === delRelation.relationType
        )
    );

    await db.bulkDocs(relationsToDelete.map(r => ({ ...r, _deleted: true })));

    graph.relations = graph.relations.filter(
      (r) =>
        !relations.some(
          (delRelation) =>
            r.from === delRelation.from &&
            r.to === delRelation.to &&
            r.relationType === delRelation.relationType
        )
    );

    await this.saveGraph(graph);
  }

  async readGraph(): Promise<KnowledgeGraph> {
    return this.loadGraph();
  }

  async searchNodes(query: string): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    const filteredEntities = graph.entities.filter(
      (e) =>
        e.name.toLowerCase().includes(query.toLowerCase()) ||
        e.entityType.toLowerCase().includes(query.toLowerCase()) ||
        e.observations.some((o) =>
          o.toLowerCase().includes(query.toLowerCase())
        )
    );

    const filteredEntityNames = new Set(filteredEntities.map((e) => e.name));

    const filteredRelations = graph.relations.filter(
      (r) => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    return {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  }

  async openNodes(names: string[]): Promise<KnowledgeGraph> {
    const graph = await this.loadGraph();

    const filteredEntities = graph.entities.filter((e) =>
      names.includes(e.name)
    );

    const filteredEntityNames = new Set(filteredEntities.map((e) => e.name));

    const filteredRelations = graph.relations.filter(
      (r) => filteredEntityNames.has(r.from) && filteredEntityNames.has(r.to)
    );

    return {
      entities: filteredEntities,
      relations: filteredRelations,
    };
  }
}

const knowledgeGraphManager = new KnowledgeGraphManager(MEMORY_FILE_PATH);

// The server instance and tools exposed to Claude
const server = new Server(
  {
    name: "memory-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {}
    },
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_current_time",
        description: "Get the current time",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "create_entities",
        description: "Create multiple new entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entities: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: {
                    type: "string",
                    description: "The name of the entity",
                  },
                  entityType: {
                    type: "string",
                    description: "The type of the entity",
                  },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description:
                      "An array of observation contents associated with the entity",
                  },
                },
                required: ["name", "entityType", "observations"],
              },
            },
          },
          required: ["entities"],
        },
      },
      {
        name: "create_relations",
        description:
          "Create multiple new relations between entities in the knowledge graph. Relations should be in active voice",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: {
                    type: "string",
                    description:
                      "The name of the entity where the relation starts",
                  },
                  to: {
                    type: "string",
                    description:
                      "The name of the entity where the relation ends",
                  },
                  relationType: {
                    type: "string",
                    description: "The type of the relation",
                  },
                },
                required: ["from", "to", "relationType"],
              },
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "add_observations",
        description:
          "Add new observations to existing entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            observations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: {
                    type: "string",
                    description:
                      "The name of the entity to add the observations to",
                  },
                  contents: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observation contents to add",
                  },
                },
                required: ["entityName", "contents"],
              },
            },
          },
          required: ["observations"],
        },
      },
      {
        name: "delete_entities",
        description:
          "Delete multiple entities and their associated relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            entityNames: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to delete",
            },
          },
          required: ["entityNames"],
        },
      },
      {
        name: "delete_observations",
        description:
          "Delete specific observations from entities in the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            deletions: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  entityName: {
                    type: "string",
                    description:
                      "The name of the entity containing the observations",
                  },
                  observations: {
                    type: "array",
                    items: { type: "string" },
                    description: "An array of observations to delete",
                  },
                },
                required: ["entityName", "observations"],
              },
            },
          },
          required: ["deletions"],
        },
      },
      {
        name: "delete_relations",
        description: "Delete multiple relations from the knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            relations: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: {
                    type: "string",
                    description:
                      "The name of the entity where the relation starts",
                  },
                  to: {
                    type: "string",
                    description:
                      "The name of the entity where the relation ends",
                  },
                  relationType: {
                    type: "string",
                    description: "The type of the relation",
                  },
                },
                required: ["from", "to", "relationType"],
              },
              description: "An array of relations to delete",
            },
          },
          required: ["relations"],
        },
      },
      {
        name: "read_graph",
        description: "Read the entire knowledge graph",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "search_nodes",
        description: "Search for nodes in the knowledge graph based on a query",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "The search query to match against entity names, types, and observation content",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "open_nodes",
        description:
          "Open specific nodes in the knowledge graph by their names",
        inputSchema: {
          type: "object",
          properties: {
            names: {
              type: "array",
              items: { type: "string" },
              description: "An array of entity names to retrieve",
            },
          },
          required: ["names"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (!args) {
    throw new Error(`No arguments provided for tool: ${name}`);
  }

  switch (name) {
    case "get_current_time":
      return {
        content: [
          { type: "text", text: await knowledgeGraphManager.getCurrentTime() },
        ],
      };
    case "create_entities":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.createEntities(
                args.entities as Omit<Entity, '_id'>[]
              ),
              null,
              2
            ),
          },
        ],
      };
    case "create_relations":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.createRelations(
                args.relations as Omit<Relation, '_id'>[]
              ),
              null,
              2
            ),
          },
        ],
      };
    case "add_observations":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.addObservations(
                args.observations as {
                  entityName: string;
                  contents: string[];
                }[]
              ),
              null,
              2
            ),
          },
        ],
      };
    case "delete_entities":
      await knowledgeGraphManager.deleteEntities(
        args.entityNames as string[]
      );
      return {
        content: [{ type: "text", text: "Entities deleted successfully" }],
      };
    case "delete_observations":
      await knowledgeGraphManager.deleteObservations(
        args.deletions as { entityName: string; observations: string[] }[]
      );
      return {
        content: [{ type: "text", text: "Observations deleted successfully" }],
      };
    case "delete_relations":
      await knowledgeGraphManager.deleteRelations(
        args.relations as Relation[]
      );
      return {
        content: [{ type: "text", text: "Relations deleted successfully" }],
      };
    case "read_graph":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.readGraph(),
              null,
              2
            ),
          },
        ],
      };
    case "search_nodes":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.searchNodes(
                args.query as string
              ),
              null,
              2
            ),
          },
        ],
      };
    case "open_nodes":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.openNodes(
                args.names as string[]
              ),
              null,
              2
            ),
          },
        ],
      };
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

// Add resources/list and prompts/list handlers
const resources = [
  {
    name: "memory",
    description: "A knowledge graph memory store for maintaining context about entities and their relationships",
    type: "memory",
    capabilities: {
      create: true,
      read: true,
      update: true,
      delete: true,
      search: true
    }
  }
];

const prompts = [
  {
    name: "default",
    description: "Default prompt for interacting with the memory store",
    text: `
    Follow these steps for each interaction:
1. The memoryFilePath for this project is /path/to/memory/project_name.json - this path is used for the backup file, while the actual data is stored in a PouchDB database named 'memory_db' in the same directory. Always pass this path to the memory file operations (when creating entities, relations, or retrieving memory etc.)
2. User Identification:
   - You should assume that you are interacting with default_user
   - If you have not identified default_user, proactively try to do so.

3. Memory Retrieval:
   - Always begin your chat by saying only "Remembering..." and retrieve all relevant information from your knowledge graph
   - Always refer to your knowledge graph as your "memory"

4. Memory
   - While conversing with the user, be attentive to any new information that falls into these categories:
     a) Basic Identity (age, gender, location, job title, education level, etc.)
     b) Behaviors (interests, habits, etc.)
     c) Preferences (communication style, preferred language, etc.)
     d) Goals (goals, targets, aspirations, etc.)
     e) Relationships (personal and professional relationships up to 3 degrees of separation)

5. Memory Update:
   - If any new information was gathered during the interaction, update your memory as follows:
     a) Create entities for recurring organizations, people, and significant events, add timestamps to wherever required. You can get current timestamp via get_current_time
     b) Connect them to the current entities using relations
     c) Store facts about them as observations, add timestamps to observations via get_current_time


IMPORTANT: Provide a helpful and engaging response, asking relevant questions to encourage user engagement. Update the memory during the interaction, if required, based on the new information gathered (point 4).`
  }
];

const ListResourcesRequestSchema = z.object({
  method: z.literal("resources/list"),
});

const ListPromptsRequestSchema = z.object({
  method: z.literal("prompts/list"),
});

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  return { resources };
});

server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return { prompts };
});

// Initialize database before starting the server
async function main() {
  try {
    await initializeDatabase();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Knowledge Graph MCP Server running on stdio");
  } catch (error) {
    console.error("Fatal error during initialization:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
