<?php

declare(strict_types=1);

namespace Emz\ExtAdministration\Controller;

use Shopware\Core\Framework\MessageQueue\Api\ConsumeMessagesController;
use Shopware\Core\Framework\MessageQueue\MessageQueueException;
use Shopware\Core\Framework\Routing\ApiRouteScope;
use Shopware\Core\PlatformRequest;
use Symfony\Component\HttpFoundation\JsonResponse;
use Symfony\Component\HttpFoundation\Request;
use Symfony\Component\Routing\Attribute\Route;

#[Route(defaults: [PlatformRequest::ATTRIBUTE_ROUTE_SCOPE => [ApiRouteScope::ID]])]
final readonly class QueueController
{
    public function __construct(private ConsumeMessagesController $consumer)
    {
    }

    #[Route(
        path: '/api/_action/emz-ext-admin/message-queue/consume',
        name: 'api.action.emz_ext_admin.message_queue.consume',
        defaults: [PlatformRequest::ATTRIBUTE_ACL => ['system:queue:process']],
        methods: ['POST']
    )]
    public function consume(Request $request): JsonResponse
    {
        try {
            return $this->consumer->consumeMessages($request);
        } catch (MessageQueueException $exception) {
            if ($exception->getErrorCode() !== MessageQueueException::WORKER_IS_LOCKED) {
                throw $exception;
            }

            return new JsonResponse(['handledMessages' => 0, 'busy' => true]);
        }
    }
}
