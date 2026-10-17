import type {ReactElement, ReactNode} from 'react';
import {Tooltip, TooltipContent, TooltipTrigger} from '@/components/ui/tooltip.tsx';

/** Says on hover what a control does, where its name does not say it all. */
export function Tip(props: {text: ReactNode; children: ReactElement}) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>{props.children}</TooltipTrigger>
            <TooltipContent className="max-w-72">{props.text}</TooltipContent>
        </Tooltip>
    );
}
