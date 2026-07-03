import { config } from "@/config";
import type {
	CommandDefinition,
	CommandRegistry as ICommandRegistry,
} from "../types";

// ─── Command Registry ─────────────────────────────────────────────────────────
// Implementação simples com Map para lookup O(1) por nome.
// Decisão: Map > array porque buscas por nome são a operação mais frequente.

export class CommandRegistry implements ICommandRegistry {
	private readonly commands = new Map<string, CommandDefinition>();

	/**
	 * Registra um comando. Lança erro em caso de nome duplicado
	 * para detectar conflitos cedo (fail-fast).
	 */
	set(name: string, command: CommandDefinition): void {
		if (this.commands.has(name)) {
			throw new Error(`[CommandRegistry] Duplicate command name: "${name}"`);
		}
		this.commands.set(name.toLowerCase(), command);
	}

	get(name: string): CommandDefinition | undefined {
		return this.commands.get(name.toLowerCase());
	}

	getAll(): CommandDefinition[] {
		return Array.from(this.commands.values());
	}

	/**
	 * Retorna comandos agrupados por categoria (para o !help).
	 */
	getByCategory(): Map<string, CommandDefinition[]> {
		const categories = new Map<string, CommandDefinition[]>();

		for (const cmd of this.commands.values()) {
			const cat = cmd.category ?? config.bot.defaultCommandCategory;
			const list = categories.get(cat) ?? [];
			list.push(cmd);
			categories.set(cat, list);
		}

		return categories;
	}

	get size(): number {
		return this.commands.size;
	}
}
