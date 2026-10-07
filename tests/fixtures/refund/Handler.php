<?php

declare(strict_types=1);

namespace Emz\ExtAdminRefundFixture;

use Shopware\Core\Checkout\Order\Aggregate\OrderTransactionCaptureRefund\OrderTransactionCaptureRefundStateHandler;
use Shopware\Core\Checkout\Payment\Cart\PaymentHandler\AbstractPaymentHandler;
use Shopware\Core\Checkout\Payment\Cart\PaymentHandler\PaymentHandlerType;
use Shopware\Core\Checkout\Payment\Cart\PaymentTransactionStruct;
use Shopware\Core\Checkout\Payment\Cart\RefundPaymentTransactionStruct;
use Shopware\Core\Framework\Context;
use Shopware\Core\Framework\Struct\Struct;
use Symfony\Component\HttpFoundation\RedirectResponse;
use Symfony\Component\HttpFoundation\Request;

/** Local acceptance fixture: changes only the test refund state, without contacting a provider. */
final class Handler extends AbstractPaymentHandler
{
    public function __construct(private readonly OrderTransactionCaptureRefundStateHandler $states)
    {
    }

    public function supports(PaymentHandlerType $type, string $paymentMethodId, Context $context): bool
    {
        return $type === PaymentHandlerType::REFUND;
    }

    public function pay(Request $request, PaymentTransactionStruct $transaction, Context $context, ?Struct $validateStruct): ?RedirectResponse
    {
        return null;
    }

    public function refund(RefundPaymentTransactionStruct $transaction, Context $context): void
    {
        $this->states->complete($transaction->getRefundId(), $context);
    }
}
