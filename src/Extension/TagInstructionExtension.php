<?php

declare(strict_types=1);

namespace Emz\ExtAdministration\Extension;

use Emz\TinkerInstructions\Core\Content\Instruction\InstructionDefinition;
use Emz\TinkerInstructions\Core\Content\Instruction\InstructionTagDefinition;
use Shopware\Core\Framework\Api\Context\AdminApiSource;
use Shopware\Core\Framework\DataAbstractionLayer\DefinitionInstanceRegistry;
use Shopware\Core\Framework\DataAbstractionLayer\EntityExtension;
use Shopware\Core\Framework\DataAbstractionLayer\Field\Flag\ApiAware;
use Shopware\Core\Framework\DataAbstractionLayer\Field\Flag\CascadeDelete;
use Shopware\Core\Framework\DataAbstractionLayer\Field\ManyToManyAssociationField;
use Shopware\Core\Framework\DataAbstractionLayer\FieldCollection;
use Shopware\Core\System\Tag\TagDefinition;

final class TagInstructionExtension extends EntityExtension
{
    public function __construct(private readonly DefinitionInstanceRegistry $definitions)
    {
    }

    public function getEntityName(): string
    {
        return TagDefinition::ENTITY_NAME;
    }

    public function extendFields(FieldCollection $collection): void
    {
        if (!$this->definitions->has('emz_instruction_tags')) {
            return;
        }

        // Shopware requires the inverse relation to paginate the plugin's instruction tags.
        $collection->add((new ManyToManyAssociationField(
            'emzInstructions',
            InstructionDefinition::class,
            InstructionTagDefinition::class,
            'tag_id',
            'instruction_id',
        ))->addFlags(new ApiAware(AdminApiSource::class), new CascadeDelete()));
    }
}
