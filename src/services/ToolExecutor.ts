import { logger } from '../utils/logger';
import type { ToolDefinition, ToolResult, ToolContext } from '../types';

type ToolHandler = (args: Record<string, any>, context: ToolContext) => Promise<ToolResult>;

interface RegisteredTool {
	handler: ToolHandler;
	definition: ToolDefinition;
}

export class ToolExecutor {
	private log = logger.child('ToolExecutor');
	private tools: Map<string, RegisteredTool> = new Map();

	register(name: string, handler: ToolHandler, definition: ToolDefinition): void {
		this.tools.set(name, { handler, definition });
	}

	getDefinitions(): ToolDefinition[] {
		return Array.from(this.tools.values()).map(t => t.definition);
	}

	async execute(name: string, args: Record<string, any>, context: ToolContext): Promise<ToolResult> {
		const tool = this.tools.get(name);
		if (!tool) {
			this.log.warn('Unknown tool', { name });
			return { success: false, error: `Unknown tool: ${name}` };
		}

		try {
			this.log.info('Executing tool', { name });
			const result = await tool.handler(args, context);
			this.log.info('Tool completed', { name, success: result.success });
			return result;
		} catch (error) {
			this.log.error('Tool execution failed', { name, error: String(error) });
			return { success: false, error: String(error) };
		}
	}

	/** Create a ToolExecutor with the default tools registered */
	static withDefaults(): ToolExecutor {
		const executor = new ToolExecutor();

		// end_call — CRITICAL: empty params only (string params crash Gemini native audio → 1011)
		executor.register(
			'end_call',
			async (_args, context) => {
				context.setPendingEndCall();
				return { success: true, data: { status: 'ending' } };
			},
			{
				name: 'end_call',
				description: 'End the current phone call gracefully. Call this when the conversation is complete or the user wants to hang up.',
				parameters: { type: 'object', properties: {} },
			}
		);

		return executor;
	}
}
