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
function Blocks({ blocks, headingOffset }: { blocks: Block[]; headingOffset: number }) {
	return blocks.map((block, index) => {
		switch (block.type) {
			case 'paragraph':
				return (
					<p key={index}>
						<Inlines pieces={block.children} />
					</p>
				);
			case 'heading': {
				const Heading = `h${Math.min(Math.max(block.level + headingOffset, 1), 6)}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
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
						<Blocks blocks={block.children} headingOffset={headingOffset} />
					</blockquote>
				);
			case 'list': {
				const items = block.items.map((item, i) => (
					<li key={i}>
						<Blocks blocks={item} headingOffset={headingOffset} />
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
			case 'table': {
				const showHead = block.head.some((cell) => cell.length > 0);
				return (
					<table key={index}>
						{showHead ? (
							<thead>
								<tr>
									{block.head.map((cell, i) => (
										<th key={i} style={block.align?.[i] ? { textAlign: block.align[i] } : undefined}>
											<Inlines pieces={cell} />
										</th>
									))}
								</tr>
							</thead>
						) : null}
						<tbody>
							{block.rows.map((row, i) => (
								<tr key={i}>
									{row.map((cell, j) => (
										<td key={j} style={block.align?.[j] ? { textAlign: block.align[j] } : undefined}>
											<Inlines pieces={cell} />
										</td>
									))}
								</tr>
							))}
						</tbody>
					</table>
				);
			}
			case 'rule':
				return <hr key={index} />;
		}
	});
}
export const Markdown = memo(function Markdown({
	text,
	headingOffset = 2,
	className,
}: {
	text: string;
	headingOffset?: number;
	className?: string;
}) {
	return (
		<div className={className ? `assistant-markdown ${className}` : 'assistant-markdown'}>
			<Blocks blocks={parseMarkdown(text)} headingOffset={headingOffset} />
		</div>
	);
});
