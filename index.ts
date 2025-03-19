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

// Define memory file path using environment variable with fallback
const defaultMemoryPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "memory.json"
);

// If MEMORY_FILE_PATH is just a filename, put it in the same directory as the script
const MEMORY_FILE_PATH = process.env.MEMORY_FILE_PATH
  ? path.isAbsolute(process.env.MEMORY_FILE_PATH)
    ? process.env.MEMORY_FILE_PATH
    : path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        process.env.MEMORY_FILE_PATH
      )
  : defaultMemoryPath;

// Initialize PouchDB with configuration from environment variables
const pouchDbPath = process.env.POUCHDB_PATH || 'memory_db';
const pouchDbOptions = process.env.POUCHDB_OPTIONS 
  ? JSON.parse(process.env.POUCHDB_OPTIONS)
  : {
      auto_compaction: true,
      revs_limit: 10
    };

const db = new PouchDB(pouchDbPath, pouchDbOptions);

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
    this.memoryFilePath = memoryFilePath;
  }

  async getCurrentTime() {
    return new Date().toISOString();
  }

  async setMemoryFilePath(memoryFilePath: string) {
    // check if path is valid
    if (!path.isAbsolute(memoryFilePath)) {
      throw new Error("Memory file path must be an absolute path");
    }
    this.memoryFilePath = memoryFilePath;
  }

  private async loadGraph(): Promise<KnowledgeGraph> {
    try {
      const result = await db.allDocs({ include_docs: true });
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
      // Save to PouchDB
      const docs = [
        ...graph.entities,
        ...graph.relations
      ];
      await db.bulkDocs(docs);
      
      // Backup to file (without type property since it's already in the entities/relations)
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
    entities: Omit<Entity, '_id'>[],
    filepath: string
  ): Promise<Entity[]> {
    await this.setMemoryFilePath(filepath);
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
    relations: Omit<Relation, '_id'>[],
    filepath: string
  ): Promise<Relation[]> {
    await this.setMemoryFilePath(filepath);
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
    observations: { entityName: string; contents: string[] }[],
    filepath: string
  ): Promise<{ entityName: string; addedObservations: string[] }[]> {
    await this.setMemoryFilePath(filepath);
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

  async deleteEntities(entityNames: string[], filepath: string): Promise<void> {
    await this.setMemoryFilePath(filepath);
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
    deletions: { entityName: string; observations: string[] }[],
    filepath: string
  ): Promise<void> {
    await this.setMemoryFilePath(filepath);
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
    relations: Relation[],
    filepath: string
  ): Promise<void> {
    await this.setMemoryFilePath(filepath);
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

  async readGraph(filepath: string): Promise<KnowledgeGraph> {
    await this.setMemoryFilePath(filepath);
    return this.loadGraph();
  }

  async searchNodes(query: string, filepath: string): Promise<KnowledgeGraph> {
    await this.setMemoryFilePath(filepath);
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

  async openNodes(names: string[], filepath: string): Promise<KnowledgeGraph> {
    await this.setMemoryFilePath(filepath);
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
      // {
      //   name: "set_memory_file_path",
      //   description: "Set the memory file path",
      //   inputSchema: {
      //     type: "object",
      //     properties: {
      //       memoryFilePath: {
      //         type: "string",
      //         description: "Absolute path to the memory file",
      //       },
      //     },
      //     required: ["memoryFilePath"],
      //   },
      // },
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["entities", "memoryFilePath"],
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["relations", "memoryFilePath"],
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["observations", "memoryFilePath"],
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["entityNames", "memoryFilePath"],
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["deletions", "memoryFilePath"],
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["relations", "memoryFilePath"],
        },
      },
      {
        name: "read_graph",
        description: "Read the entire knowledge graph",
        inputSchema: {
          type: "object",
          properties: {
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["memoryFilePath"],
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["query", "memoryFilePath"],
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
            memoryFilePath: {
              type: "string",
              description: "The path to the memory file",
            },
          },
          required: ["names", "memoryFilePath"],
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
    // case "set_memory_file_path":
    //   knowledgeGraphManager.setMemoryFilePath(args.memoryFilePath as string);
    //   return {
    //     content: [{ type: "text", text: "Memory file path set successfully" }],
    //   };
    case "create_entities":
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              await knowledgeGraphManager.createEntities(
                args.entities as Omit<Entity, '_id'>[],
                args.memoryFilePath as string
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
                args.relations as Omit<Relation, '_id'>[],
                args.memoryFilePath as string
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
                }[],
                args.memoryFilePath as string
              ),
              null,
              2
            ),
          },
        ],
      };
    case "delete_entities":
      await knowledgeGraphManager.deleteEntities(
        args.entityNames as string[],
        args.memoryFilePath as string
      );
      return {
        content: [{ type: "text", text: "Entities deleted successfully" }],
      };
    case "delete_observations":
      await knowledgeGraphManager.deleteObservations(
        args.deletions as { entityName: string; observations: string[] }[],
        args.memoryFilePath as string
      );
      return {
        content: [{ type: "text", text: "Observations deleted successfully" }],
      };
    case "delete_relations":
      await knowledgeGraphManager.deleteRelations(
        args.relations as Relation[],
        args.memoryFilePath as string
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
              await knowledgeGraphManager.readGraph(
                args.memoryFilePath as string
              ),
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
                args.query as string,
                args.memoryFilePath as string
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
                args.names as string[],
                args.memoryFilePath as string
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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Knowledge Graph MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
