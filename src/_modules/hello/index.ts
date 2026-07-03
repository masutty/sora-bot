import { defineModule, defineCommand } from '@/define';
import { Logger } from '@/utils/logging';

const logger = new Logger('hello.index');

const helloCommand = defineCommand({
    name: 'hello',
    description: 'Says hello',
    hidden: true,
    async execute(ctx) {
        logger.debug(`Context: ${JSON.stringify(ctx)}`);
        await ctx.reply({ content: `Hello, ${ctx.user.displayName}!` });
        throw new Error("TEST ERROR");
    },
})

export default defineModule({
    name: 'hello',
    description: 'Minimal-code module example',
    authors: [{ name: 'masutty', id: 188851299255713792n }],
    commands: [ helloCommand ],
});
