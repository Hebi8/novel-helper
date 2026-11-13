import { Fragment, memo } from 'react';
import { parseMarkdown, type Block, type Inline } from '../../core/markdown';

function Inlines({ pieces }: { pieces: Inline[] }) {
	return pieces.map((piece, index) => {
		if (typeof piece === 'string') {
			return <Fragment key={index}>{piece}</Fragment>;
		}
		if (piece.type === 'code') {
			return <code key={index}>{piece.text}</code>;
		}
		if (piece.type === 'link') {
			return (
				<a
					key={index}
					href={piece.href}
					onClick={(event) => {
						event.preventDefault();
						void window.novel.assistant.openLink(piece.href);
					}}
				>
					<Inlines pieces={piece.children} />
				</a>
			);
		}
		const Tag = piece.type;
		return (
			<Tag key={index}>
				<Inlines pieces={piece.children} />
			</Tag>
		);
	});
}
function Blocks({ blocks }: { blocks: Block[] }) {
	return blocks.map((block, index) => {
		switch (block.type) {
			case 'paragraph':
				return (
					<p key={index}>
						<Inlines pieces={block.children} />
					</p>
				);
			case 'heading': {
				const Heading = `h${Math.min(block.level + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6';
				return (
					<Heading key={index}>
						<Inlines pieces={block.children} />
					</Heading>
				);
			}
			case 'code':
				return (
					<pre key={index}>
						<code>{block.text}</code>
					</pre>
				);
			case 'quote':
				return (
					<blockquote key={index}>
						<Blocks blocks={block.children} />
					</blockquote>
				);
			case 'list': {
				const items = block.items.map((item, i) => (
					<li key={i}>
						<Blocks blocks={item} />
					</li>
				));
				return block.ordered ? (
					<ol key={index} start={block.start}>
						{items}
					</ol>
				) : (
					<ul key={index}>{items}</ul>
				);
			}
			case 'table':
				return (
					<table key={index}>
						<thead>
							<tr>
								{block.head.map((cell, i) => (
									<th key={i}>
										<Inlines pieces={cell} />
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{block.rows.map((row, i) => (
								<tr key={i}>
									{row.map((cell, j) => (
										<td key={j}>
											<Inlines pieces={cell} />
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				);
			case 'rule':
				return <hr key={index} />;
		}
	});
}
export const Markdown = memo(function Markdown({ text }: { text: string }) {
	return (
		<div className="assistant-markdown">
			<Blocks blocks={parseMarkdown(text)} />
		</div>
	);
});
